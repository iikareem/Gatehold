import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as targets from "aws-cdk-lib/aws-scheduler-targets";
import { Construct } from "constructs";
import { baseLambdaEnv, createGoFn, projectRoot } from "../helpers/node-fn";

export interface ReconcilerProps {
  stage: string;
  eventsTable: dynamodb.ITable;
  ordersTable: dynamodb.ITable;
  seatsTable: dynamodb.ITable;
}

/**
 * Phase 12 — detect-only reconciler: scheduled Go Lambda, read-only on
 * Events / Orders / Seats. Finds CONFIRMED orders whose seats are not SOLD;
 * EMF + alarm surface ReconcilerInconsistencies (slice 12e).
 */
export class Reconciler extends Construct {
  readonly reconcilerFn: lambda.IFunction;
  readonly inconsistenciesAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: ReconcilerProps) {
    super(scope, id);

    const { stage, eventsTable, ordersTable, seatsTable } = props;

    const lambdaEnv = {
      ...baseLambdaEnv(stage, {
        eventsTableName: eventsTable.tableName,
        seatsTableName: seatsTable.tableName,
      }),
      ORDERS_TABLE_NAME: ordersTable.tableName,
    };

    this.reconcilerFn = createGoFn(this, "ReconcilerFn", {
      stage,
      name: "reconciler",
      zipPath: path.join(projectRoot, "go/reconciler/dist/reconciler.zip"),
      timeout: cdk.Duration.seconds(60),
      environment: lambdaEnv,
    });

    eventsTable.grantReadData(this.reconcilerFn);
    ordersTable.grantReadData(this.reconcilerFn);
    seatsTable.grantReadData(this.reconcilerFn);

    new scheduler.Schedule(this, "ReconcilerSchedule", {
      scheduleName: `gatehold-${stage}-reconciler`,
      description: "Detect CONFIRMED orders without matching SOLD seats",
      schedule: scheduler.ScheduleExpression.rate(cdk.Duration.minutes(5)),
      target: new targets.LambdaInvoke(this.reconcilerFn),
    });

    // 12e — EMF → Gatehold/ReconcilerInconsistencies; alert when any finding.
    this.inconsistenciesAlarm = new cloudwatch.Alarm(
      this,
      "ReconcilerInconsistenciesAlarm",
      {
        alarmName: `gatehold-${stage}-reconciler-inconsistencies`,
        alarmDescription:
          "Detect-only reconciler found CONFIRMED orders without matching SOLD seats",
        metric: new cloudwatch.Metric({
          namespace: "Gatehold",
          metricName: "ReconcilerInconsistencies",
          dimensionsMap: { stage },
          statistic: "Sum",
          period: cdk.Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
  }
}
