import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { Auth } from "./constructs/auth";
import { Config } from "./constructs/config";
import { DataPlane } from "./constructs/data-plane";
import { DomainEvents } from "./constructs/domain-events";
import { HoldCapability } from "./constructs/hold-capability";
import { HttpApi } from "./constructs/http-api";
import { OrderAccept } from "./constructs/order-accept";
import { PurchaseSaga } from "./constructs/purchase-saga";
import { TicketStore } from "./constructs/ticket-store";
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

    const config = new Config(this, "Config", { stage, removalPolicy });

    const auth = new Auth(this, "Auth", { stage, removalPolicy });
    const holds = new HoldCapability(this, "Holds", {
      stage,
      seatsTable: data.seatsTable,
      eventsTableName: data.eventsTable.tableName,
      holdTtlMsParam: config.holdTtlMsParam,
      maxHoldSeatsParam: config.maxHoldSeatsParam,
    });

    // Phase 10a/b/c — bucket + signing key before Orders (get-order) + PurchaseSaga.
    const tickets = new TicketStore(this, "Tickets", { stage, removalPolicy });

    const orders = new OrderAccept(this, "Orders", {
      stage,
      removalPolicy,
      eventsTable: data.eventsTable,
      seatsTable: data.seatsTable,
      ordersTable: data.ordersTable,
      idempotencyTable: data.idempotencyTable,
      maxHoldSeatsParam: config.maxHoldSeatsParam,
      ticketsBucket: tickets.ticketsBucket,
    });

    const purchase = new PurchaseSaga(this, "Purchase", {
      stage,
      eventsTable: data.eventsTable,
      seatsTable: data.seatsTable,
      ordersTable: data.ordersTable,
      ledgerTable: data.ledgerTable,
      orderQueue: orders.orderQueue,
      mockPaymentSecret: config.mockPaymentSecret,
      mockPaymentUrl: config.mockPaymentUrl,
      ticketsBucket: tickets.ticketsBucket,
      ticketSigningKey: tickets.signingKey,
    });

    const http = new HttpApi(this, "Http", {
      stage,
      eventsTable: data.eventsTable,
      seatsTable: data.seatsTable,
      holdSeatFn: holds.holdSeatFn,
      createOrderFn: orders.createOrderFn,
      getOrderFn: orders.getOrderFn,
      ticketSigningKey: tickets.signingKey,
      userPool: auth.userPool,
      userPoolClient: auth.userPoolClient,
      userPoolIssuer: auth.issuerUrl,
    });

    const domainEvents = new DomainEvents(this, "DomainEvents", {
      stage,
      removalPolicy,
      ordersTable: data.ordersTable,
    });

    addGateholdOutputs(this, {
      data,
      config,
      auth,
      holds,
      orders,
      purchase,
      http,
      domainEvents,
      tickets,
    });
  }
}
