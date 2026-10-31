import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sources from "aws-cdk-lib/aws-lambda-event-sources";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import {
  createGoFn,
  dockerReachableEndpoint,
  projectRoot,
} from "../helpers/node-fn";

export interface CancelRefundProps {
  stage: string;
  removalPolicy: cdk.RemovalPolicy;
  /** Events table with NEW_AND_OLD_IMAGES stream (ON_SALE → CANCELLING). */
  eventsTable: dynamodb.ITable;
  ordersTable: dynamodb.ITable;
  refundBatchesTable: dynamodb.ITable;
}

/**
 * Phase 11c — cancel refund fan-out plane.
 *
 * Events stream → Go refund-orchestrator → RefundBatch checkpoint + SQS refunds (+ DLQ).
 * Worker attachment is Slice 11d.
 */
export class CancelRefund extends Construct {
  readonly refundDlq: sqs.Queue;
  readonly refundQueue: sqs.Queue;
  readonly refundOrchestratorFn: lambda.IFunction;

  constructor(scope: Construct, id: string, props: CancelRefundProps) {
    super(scope, id);

    const {
      stage,
      removalPolicy,
      eventsTable,
      ordersTable,
      refundBatchesTable,
    } = props;

    this.refundDlq = new sqs.Queue(this, "RefundDlq", {
      queueName: `gatehold-${stage}-refunds-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy,
    });

    this.refundQueue = new sqs.Queue(this, "RefundQueue", {
      queueName: `gatehold-${stage}-refunds`,
      // Must exceed refund-worker timeout (Slice 11d).
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
      // Large events may need several Query + SendMessageBatch pages.
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        STAGE: stage,
        EVENTS_TABLE_NAME: eventsTable.tableName,
        ORDERS_TABLE_NAME: ordersTable.tableName,
        REFUND_BATCHES_TABLE_NAME: refundBatchesTable.tableName,
        REFUND_QUEUE_URL: this.refundQueue.queueUrl,
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
  }
}
