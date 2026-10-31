import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

export interface DataPlaneProps {
  stage: string;
  removalPolicy: cdk.RemovalPolicy;
}

/**
 * DynamoDB data plane: creates Gatehold tables (+ Orders GSIs) and exposes them.
 *
 * Callers pass stage/removal only — they do not create tables outside and pass
 * them in. Read `eventsTable`, `seatsTable`, etc. after construction.
 */
export class DataPlane extends Construct {
  readonly eventsTable: dynamodb.Table;
  readonly seatsTable: dynamodb.Table;
  readonly ordersTable: dynamodb.Table;
  readonly idempotencyTable: dynamodb.Table;
  readonly ledgerTable: dynamodb.Table;
  /** Phase 11a — mass-refund batch checkpoint + counters. */
  readonly refundBatchesTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DataPlaneProps) {
    super(scope, id);

    const { stage, removalPolicy } = props;

    this.eventsTable = new dynamodb.Table(this, "EventsTable", {
      tableName: `gatehold-${stage}-events`,
      partitionKey: { name: "eventId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
      // Phase 11a — refund orchestrator watches ON_SALE → CANCELLING.
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    this.seatsTable = new dynamodb.Table(this, "SeatsTable", {
      tableName: `gatehold-${stage}-seats`,
      partitionKey: { name: "eventId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "seatId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    });

    this.ordersTable = new dynamodb.Table(this, "OrdersTable", {
      tableName: `gatehold-${stage}-orders`,
      partitionKey: { name: "orderId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
      // Phase 8a — stream-relay reads PENDING→CONFIRMED (and later other transitions).
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });
    this.ordersTable.addGlobalSecondaryIndex({
      indexName: "userId",
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    this.ordersTable.addGlobalSecondaryIndex({
      indexName: "eventId-status",
      partitionKey: { name: "eventId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "status", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.idempotencyTable = new dynamodb.Table(this, "IdempotencyTable", {
      tableName: `gatehold-${stage}-idempotency`,
      partitionKey: { name: "key", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
      timeToLiveAttribute: "ttl",
    });

    this.ledgerTable = new dynamodb.Table(this, "LedgerTable", {
      tableName: `gatehold-${stage}-ledger`,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    });

    this.refundBatchesTable = new dynamodb.Table(this, "RefundBatchesTable", {
      tableName: `gatehold-${stage}-refund-batches`,
      partitionKey: { name: "batchId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    });
  }
}
