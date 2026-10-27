import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { DataPlane } from "./constructs/data-plane";
import { DomainEvents } from "./constructs/domain-events";
import { HoldCapability } from "./constructs/hold-capability";
import { HttpApi } from "./constructs/http-api";
import { OrderAccept } from "./constructs/order-accept";
import { PurchaseSaga } from "./constructs/purchase-saga";
import { addGateholdOutputs } from "./helpers/stack-outputs";

export interface GateholdStackProps extends cdk.StackProps {
  stage: string;
}

/**
 * Thin composer: wires domain constructs and stack outputs.
 * Phase 0–6 behavior lives in constructs under `infra/lib/constructs/`.
 */
export class GateholdStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GateholdStackProps) {
    super(scope, id, props);

    const { stage } = props;
    const removalPolicy =
      stage === "prod"
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY;

    const data = new DataPlane(this, "Data", { stage, removalPolicy });

    const holds = new HoldCapability(this, "Holds", {
      stage,
      seatsTable: data.seatsTable,
      eventsTableName: data.eventsTable.tableName,
    });

    const orders = new OrderAccept(this, "Orders", {
      stage,
      removalPolicy,
      eventsTable: data.eventsTable,
      seatsTable: data.seatsTable,
      ordersTable: data.ordersTable,
      idempotencyTable: data.idempotencyTable,
    });

    const purchase = new PurchaseSaga(this, "Purchase", {
      stage,
      eventsTable: data.eventsTable,
      seatsTable: data.seatsTable,
      ordersTable: data.ordersTable,
      ledgerTable: data.ledgerTable,
      orderQueue: orders.orderQueue,
    });

    const http = new HttpApi(this, "Http", {
      stage,
      eventsTable: data.eventsTable,
      seatsTable: data.seatsTable,
      holdSeatFn: holds.holdSeatFn,
      createOrderFn: orders.createOrderFn,
    });

    const domainEvents = new DomainEvents(this, "DomainEvents", {
      stage,
      removalPolicy,
      ordersTable: data.ordersTable,
    });

    addGateholdOutputs(this, {
      data,
      holds,
      orders,
      purchase,
      http,
      domainEvents,
    });
  }
}
