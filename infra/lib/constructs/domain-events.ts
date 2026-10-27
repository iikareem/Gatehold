import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sources from "aws-cdk-lib/aws-lambda-event-sources";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import {
  createGoFn,
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
 * 8b: PutEvents on custom bus + OrderConfirmed → CloudWatch Logs rule.
 * Later: SNS / SQS / SES targets — not in GateholdStack.
 */
export class DomainEvents extends Construct {
  readonly streamRelayFn: lambda.IFunction;
  readonly eventBus: events.IEventBus;
  readonly orderConfirmedLogGroup: logs.ILogGroup;

  constructor(scope: Construct, id: string, props: DomainEventsProps) {
    super(scope, id);

    const { stage, removalPolicy, ordersTable } = props;

    this.eventBus = new events.EventBus(this, "DomainBus", {
      eventBusName: `gatehold-${stage}`,
    });

    // Slice 8b visibility: bus → logs (no SNS/SES yet).
    this.orderConfirmedLogGroup = new logs.LogGroup(
      this,
      "OrderConfirmedLogGroup",
      {
        logGroupName: `/gatehold/${stage}/order-confirmed`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy,
      },
    );

    new events.Rule(this, "OrderConfirmedToLogs", {
      eventBus: this.eventBus,
      ruleName: `gatehold-${stage}-order-confirmed-logs`,
      description: "Phase 8b — inspect OrderConfirmed on the bus",
      eventPattern: {
        source: [ORDERS_EVENT_SOURCE],
        detailType: ["OrderConfirmed"],
      },
      targets: [new targets.CloudWatchLogGroup(this.orderConfirmedLogGroup)],
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
