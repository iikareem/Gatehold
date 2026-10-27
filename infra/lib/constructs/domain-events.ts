import * as path from "path";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sources from "aws-cdk-lib/aws-lambda-event-sources";
import { Construct } from "constructs";
import {
  createGoFn,
  dockerReachableEndpoint,
  projectRoot,
} from "../helpers/node-fn";

export interface DomainEventsProps {
  stage: string;
  /** Orders table must have a stream (NEW_AND_OLD_IMAGES). */
  ordersTable: dynamodb.ITable;
}

/**
 * Phase 8 domain-events plane.
 *
 * Slice 8a: Orders DynamoDB stream → Go stream-relay (log PENDING→CONFIRMED).
 * Later slices add EventBridge / SNS / SQS / SES here — not in GateholdStack.
 */
export class DomainEvents extends Construct {
  readonly streamRelayFn: lambda.IFunction;

  constructor(scope: Construct, id: string, props: DomainEventsProps) {
    super(scope, id);

    const { stage, ordersTable } = props;

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
