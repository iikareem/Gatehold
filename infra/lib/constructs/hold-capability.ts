import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as targets from "aws-cdk-lib/aws-scheduler-targets";
import { Construct } from "constructs";
import {
  baseLambdaEnv,
  createGoFn,
  createNodeFn,
  projectRoot,
} from "../helpers/node-fn";

export interface HoldCapabilityProps {
  stage: string;
  /** Seats table — hold-seat + sweeper get R/W inside this construct. */
  seatsTable: dynamodb.ITable;
  /** For Lambda env (`EVENTS_TABLE_NAME`); no Events grants here. */
  eventsTableName: string;
}

/**
 * Hold capability: hold-seat Lambda, Go hold-sweeper, and the 1-minute
 * EventBridge Scheduler that invokes the sweeper.
 *
 * Owns seats R/W for both Lambdas. Exposes `holdSeatFn` for the HTTP API
 * and `holdSweeperFn` for outputs / diagnostics.
 */
export class HoldCapability extends Construct {
  readonly holdSeatFn: lambda.IFunction;
  readonly holdSweeperFn: lambda.IFunction;

  constructor(scope: Construct, id: string, props: HoldCapabilityProps) {
    super(scope, id);

    const { stage, seatsTable, eventsTableName } = props;

    const lambdaEnv = baseLambdaEnv(stage, {
      eventsTableName,
      seatsTableName: seatsTable.tableName,
    });

    this.holdSeatFn = createNodeFn(this, "HoldSeatFn", {
      stage,
      name: "hold-seat",
      entry: path.join(projectRoot, "services/hold-seat/src/handler.ts"),
      environment: lambdaEnv,
    });

    // Go custom runtime: zip built by `npm run build:hold-sweeper` (bootstrap).
    this.holdSweeperFn = createGoFn(this, "HoldSweeperFn", {
      stage,
      name: "hold-sweeper",
      zipPath: path.join(projectRoot, "go/hold-sweeper/dist/hold-sweeper.zip"),
      timeout: cdk.Duration.seconds(60),
      environment: lambdaEnv,
    });

    seatsTable.grantReadWriteData(this.holdSeatFn);
    seatsTable.grantReadWriteData(this.holdSweeperFn);

    // Timer only (not the Phase 8 domain event bus).
    new scheduler.Schedule(this, "HoldSweeperSchedule", {
      scheduleName: `gatehold-${stage}-hold-sweeper`,
      description: "Release expired HELD seats (hold-sweeper)",
      schedule: scheduler.ScheduleExpression.rate(cdk.Duration.minutes(1)),
      target: new targets.LambdaInvoke(this.holdSweeperFn),
    });
  }
}
