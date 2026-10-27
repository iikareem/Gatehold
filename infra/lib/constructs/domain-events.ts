import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sources from "aws-cdk-lib/aws-lambda-event-sources";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import {
  createGoFn,
  createNodeFn,
  dockerReachableEndpoint,
  projectRoot,
} from "../helpers/node-fn";

/** EventBridge source for order domain events (contracts.md). */
export const ORDERS_EVENT_SOURCE = "gatehold.orders";

export interface DomainEventsProps {
  stage: string;
  removalPolicy: cdk.RemovalPolicy;
  /** Orders table must have a stream (NEW_AND_OLD_IMAGES). */
  ordersTable: dynamodb.ITable;
}

/**
 * Phase 8 domain-events plane.
 *
 * 8a: Orders stream → Go stream-relay (filter PENDING→CONFIRMED).
 * 8b: PutEvents on custom bus + OrderConfirmed → log Lambda
 *     (MiniStack does not deliver EventBridge → CloudWatch Logs reliably).
 * 8c: OrderConfirmed → SNS → SQS (+ DLQ); inspect via MiniStack SQS.
 * Later: SQS → notify-email → SES (8d).
 */
export class DomainEvents extends Construct {
  readonly streamRelayFn: lambda.IFunction;
  readonly orderConfirmedLoggerFn: lambda.IFunction;
  readonly eventBus: events.IEventBus;
  readonly orderNotificationsTopic: sns.ITopic;
  readonly orderNotificationsQueue: sqs.IQueue;
  readonly orderNotificationsDlq: sqs.IQueue;

  constructor(scope: Construct, id: string, props: DomainEventsProps) {
    super(scope, id);

    const { stage, removalPolicy, ordersTable } = props;

    this.eventBus = new events.EventBus(this, "DomainBus", {
      eventBusName: `gatehold-${stage}`,
    });

    // Slice 8b visibility: bus → Lambda (works on MiniStack; CW Logs target does not).
    this.orderConfirmedLoggerFn = createNodeFn(this, "OrderConfirmedLoggerFn", {
      stage,
      name: "order-confirmed-logger",
      entry: path.join(
        projectRoot,
        "services/order-confirmed-logger/src/handler.ts",
      ),
      timeout: cdk.Duration.seconds(10),
      environment: {
        STAGE: stage,
      },
    });

    new events.Rule(this, "OrderConfirmedToLogger", {
      eventBus: this.eventBus,
      ruleName: `gatehold-${stage}-order-confirmed-logger`,
      description: "Phase 8b — inspect OrderConfirmed via Lambda logs",
      eventPattern: {
        source: [ORDERS_EVENT_SOURCE],
        detailType: ["OrderConfirmed"],
      },
      targets: [new targets.LambdaFunction(this.orderConfirmedLoggerFn)],
    });

    // Slice 8c: bus → SNS → SQS (+ DLQ). No consumer until 8d.
    this.orderNotificationsDlq = new sqs.Queue(this, "OrderNotificationsDlq", {
      queueName: `gatehold-${stage}-order-notifications-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy,
    });

    this.orderNotificationsQueue = new sqs.Queue(
      this,
      "OrderNotificationsQueue",
      {
        queueName: `gatehold-${stage}-order-notifications`,
        // 8d notify-email will drain this; keep headroom above Lambda timeout.
        visibilityTimeout: cdk.Duration.seconds(60),
        retentionPeriod: cdk.Duration.days(4),
        removalPolicy,
        deadLetterQueue: {
          queue: this.orderNotificationsDlq,
          maxReceiveCount: 5,
        },
      },
    );

    this.orderNotificationsTopic = new sns.Topic(
      this,
      "OrderNotificationsTopic",
      {
        topicName: `gatehold-${stage}-order-notifications`,
        displayName: `Gatehold ${stage} order notifications`,
      },
    );

    this.orderNotificationsTopic.addSubscription(
      new subscriptions.SqsSubscription(this.orderNotificationsQueue),
    );

    new events.Rule(this, "OrderConfirmedToSns", {
      eventBus: this.eventBus,
      ruleName: `gatehold-${stage}-order-confirmed-sns`,
      description: "Phase 8c — fan-out OrderConfirmed to SNS → SQS",
      eventPattern: {
        source: [ORDERS_EVENT_SOURCE],
        detailType: ["OrderConfirmed"],
      },
      targets: [new targets.SnsTopic(this.orderNotificationsTopic)],
    });

    this.streamRelayFn = createGoFn(this, "StreamRelayFn", {
      stage,
      name: "stream-relay",
      zipPath: path.join(
        projectRoot,
        "go/stream-relay/dist/stream-relay.zip",
      ),
      environment: {
        STAGE: stage,
        ORDERS_TABLE_NAME: ordersTable.tableName,
        EVENT_BUS_NAME: this.eventBus.eventBusName,
        EVENT_SOURCE: ORDERS_EVENT_SOURCE,
        ...(process.env.AWS_ENDPOINT_URL
          ? {
              AWS_ENDPOINT_URL: dockerReachableEndpoint(
                process.env.AWS_ENDPOINT_URL,
              ),
            }
          : {}),
      },
    });

    ordersTable.grantStreamRead(this.streamRelayFn);
    this.eventBus.grantPutEventsTo(this.streamRelayFn);

    this.streamRelayFn.addEventSource(
      new sources.DynamoEventSource(ordersTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        retryAttempts: 2,
        reportBatchItemFailures: false,
      }),
    );
  }
}
