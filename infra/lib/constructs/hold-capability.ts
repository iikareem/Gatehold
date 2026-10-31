import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as targets from "aws-cdk-lib/aws-scheduler-targets";
import { Construct } from "constructs";
import { grantTableWriteWithTransact } from "../helpers/iam-grants";
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
  /** Events table — hold-seat ConditionCheck ON_SALE (Phase 11b). */
  eventsTable: dynamodb.ITable;
  /** Hold TTL ms SSM param (Phase 9d.3). */
  holdTtlMsParam: ssm.IStringParameter;
  /** Max seats per hold SSM param (Phase 9d.3). */
  maxHoldSeatsParam: ssm.IStringParameter;
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

    const {
      stage,
      seatsTable,
      eventsTable,
      holdTtlMsParam,
      maxHoldSeatsParam,
    } = props;

    const lambdaEnv = baseLambdaEnv(stage, {
      eventsTableName: eventsTable.tableName,
      seatsTableName: seatsTable.tableName,
    });

    this.holdSeatFn = createNodeFn(this, "HoldSeatFn", {
      stage,
      name: "hold-seat",
      entry: path.join(projectRoot, "services/hold-seat/src/handler.ts"),
      environment: {
        ...lambdaEnv,
        HOLD_TTL_MS_PARAM_NAME: holdTtlMsParam.parameterName,
        MAX_HOLD_SEATS_PARAM_NAME: maxHoldSeatsParam.parameterName,
      },
    });

    // Go custom runtime: zip built by `npm run build:hold-sweeper` (bootstrap).
    this.holdSweeperFn = createGoFn(this, "HoldSweeperFn", {
      stage,
      name: "hold-sweeper",
      zipPath: path.join(projectRoot, "go/hold-sweeper/dist/hold-sweeper.zip"),
      timeout: cdk.Duration.seconds(60),
      environment: lambdaEnv,
    });

    // hold-seat: event ConditionCheck (read) + seats TransactWrite.
    // sweeper: Scan + Update → needs read+write on seats only.
    eventsTable.grantReadData(this.holdSeatFn);
    grantTableWriteWithTransact(seatsTable, this.holdSeatFn);
    seatsTable.grantReadWriteData(this.holdSweeperFn);
    holdTtlMsParam.grantRead(this.holdSeatFn);
    maxHoldSeatsParam.grantRead(this.holdSeatFn);

    // Timer only (not the Phase 8 domain event bus).
    new scheduler.Schedule(this, "HoldSweeperSchedule", {
      scheduleName: `gatehold-${stage}-hold-sweeper`,
      description: "Release expired HELD seats (hold-sweeper)",
      schedule: scheduler.ScheduleExpression.rate(cdk.Duration.minutes(1)),
      target: new targets.LambdaInvoke(this.holdSweeperFn),
    });
  }
}
