import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sources from "aws-cdk-lib/aws-lambda-event-sources";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as targets from "aws-cdk-lib/aws-scheduler-targets";
import { Construct } from "constructs";
import {
  createGoFn,
  createNodeFn,
  dockerReachableEndpoint,
  projectRoot,
} from "../helpers/node-fn";

export interface CancelRefundProps {
  stage: string;
  removalPolicy: cdk.RemovalPolicy;
  /** Events table with NEW_AND_OLD_IMAGES stream (ON_SALE → CANCELLING). */
  eventsTable: dynamodb.ITable;
  ordersTable: dynamodb.ITable;
  ledgerTable: dynamodb.ITable;
  refundBatchesTable: dynamodb.ITable;
  mockPaymentSecret: secretsmanager.ISecret;
}

/**
 * Phase 11 — cancel refund plane.
 *
 * 11c: Events stream → Go refund-orchestrator → RefundBatch + SQS refunds (+ DLQ).
 * 11d: SQS → TS refund-worker → provider refund + ledger + order REFUNDED.
 * 11e: drain check → batch COMPLETE* + event CANCELLED; GET /admin/.../refunds.
 * 11f1: EventBridge Scheduler → same Go Lambda sweeps stale fan-outs (lastFanOutAt).
 */
export class CancelRefund extends Construct {
  readonly refundDlq: sqs.Queue;
  readonly refundQueue: sqs.Queue;
  readonly refundOrchestratorFn: lambda.IFunction;
  readonly refundWorkerFn: lambda.IFunction;

  constructor(scope: Construct, id: string, props: CancelRefundProps) {
    super(scope, id);

    const {
      stage,
      removalPolicy,
      eventsTable,
      ordersTable,
      ledgerTable,
      refundBatchesTable,
      mockPaymentSecret,
    } = props;

    this.refundDlq = new sqs.Queue(this, "RefundDlq", {
      queueName: `gatehold-${stage}-refunds-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy,
    });

    this.refundQueue = new sqs.Queue(this, "RefundQueue", {
      queueName: `gatehold-${stage}-refunds`,
      // Must exceed refund-worker timeout.
      visibilityTimeout: cdk.Duration.seconds(90),
      retentionPeriod: cdk.Duration.days(4),
      removalPolicy,
      deadLetterQueue: {
        queue: this.refundDlq,
        maxReceiveCount: 5,
      },
    });

    this.refundOrchestratorFn = createGoFn(this, "RefundOrchestratorFn", {
      stage,
      name: "refund-orchestrator",
      zipPath: path.join(
        projectRoot,
        "go/refund-orchestrator/dist/refund-orchestrator.zip",
      ),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        STAGE: stage,
        EVENTS_TABLE_NAME: eventsTable.tableName,
        ORDERS_TABLE_NAME: ordersTable.tableName,
        REFUND_BATCHES_TABLE_NAME: refundBatchesTable.tableName,
        REFUND_QUEUE_URL: this.refundQueue.queueUrl,
        // 11f1 — resume fan-out when lastFanOutAt is older than this.
        FAN_OUT_STALE_AFTER_SECONDS: "300",
        ...(process.env.AWS_ENDPOINT_URL
          ? {
              AWS_ENDPOINT_URL: dockerReachableEndpoint(
                process.env.AWS_ENDPOINT_URL,
              ),
            }
          : {}),
      },
    });

    eventsTable.grantStreamRead(this.refundOrchestratorFn);
    eventsTable.grantReadWriteData(this.refundOrchestratorFn);
    ordersTable.grantReadData(this.refundOrchestratorFn);
    refundBatchesTable.grantReadWriteData(this.refundOrchestratorFn);
    this.refundQueue.grantSendMessages(this.refundOrchestratorFn);

    // Filter ON_SALE→CANCELLING in Go (MiniStack filter criteria is unreliable).
    this.refundOrchestratorFn.addEventSource(
      new sources.DynamoEventSource(eventsTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 1,
        retryAttempts: 3,
        reportBatchItemFailures: false,
      }),
    );

    // 11f1 — timer wake-up for stuck RUNNING fan-outs (same fanOutEvent path).
    new scheduler.Schedule(this, "RefundFanOutSweeperSchedule", {
      scheduleName: `gatehold-${stage}-refund-fanout-sweeper`,
      description: "Resume stuck refund fan-outs (refund-orchestrator sweep)",
      schedule: scheduler.ScheduleExpression.rate(cdk.Duration.minutes(5)),
      target: new targets.LambdaInvoke(this.refundOrchestratorFn),
    });

    this.refundWorkerFn = createNodeFn(this, "RefundWorkerFn", {
      stage,
      name: "refund-worker",
      entry: path.join(projectRoot, "services/refund-worker/src/handler.ts"),
      timeout: cdk.Duration.seconds(30),
      environment: {
        STAGE: stage,
        ORDERS_TABLE_NAME: ordersTable.tableName,
        LEDGER_TABLE_NAME: ledgerTable.tableName,
        REFUND_BATCHES_TABLE_NAME: refundBatchesTable.tableName,
        EVENTS_TABLE_NAME: eventsTable.tableName,
        MOCK_PAYMENT_SECRET_ARN: mockPaymentSecret.secretArn,
        ...(process.env.AWS_ENDPOINT_URL
          ? {
              AWS_ENDPOINT_URL: dockerReachableEndpoint(
                process.env.AWS_ENDPOINT_URL,
              ),
            }
          : {}),
      },
    });

    ordersTable.grantReadWriteData(this.refundWorkerFn);
    ledgerTable.grantReadWriteData(this.refundWorkerFn);
    refundBatchesTable.grantReadWriteData(this.refundWorkerFn);
    eventsTable.grantReadWriteData(this.refundWorkerFn);
    mockPaymentSecret.grantRead(this.refundWorkerFn);
    this.refundQueue.grantConsumeMessages(this.refundWorkerFn);

    this.refundWorkerFn.addEventSource(
      new sources.SqsEventSource(this.refundQueue, {
        batchSize: 5,
        reportBatchItemFailures: true,
      }),
    );
  }
}
