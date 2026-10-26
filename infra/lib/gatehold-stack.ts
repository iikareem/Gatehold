import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { DataPlane } from "./constructs/data-plane";
import { HoldCapability } from "./constructs/hold-capability";
import { HttpApi } from "./constructs/http-api";
import { OrderAccept } from "./constructs/order-accept";
import { PurchaseSaga } from "./constructs/purchase-saga";

export interface GateholdStackProps extends cdk.StackProps {
  stage: string;
}

/**
 * Phase 0–6 stack + Phase 7 slices 0–5:
 * DataPlane, HoldCapability, OrderAccept, PurchaseSaga, HttpApi.
 * Slice 6 thins this composer further (docs / MiniStack smoke).
 */
export class GateholdStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GateholdStackProps) {
    super(scope, id, props);

    const { stage } = props;
    const removal =
      stage === "prod"
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY;

    const data = new DataPlane(this, "Data", {
      stage,
      removalPolicy: removal,
    });
    const {
      eventsTable,
      seatsTable,
      ordersTable,
      idempotencyTable,
      ledgerTable,
    } = data;

    const holdCapability = new HoldCapability(this, "Holds", {
      stage,
      seatsTable,
      eventsTableName: eventsTable.tableName,
    });
    const { holdSeatFn, holdSweeperFn } = holdCapability;

    const orderAccept = new OrderAccept(this, "Orders", {
      stage,
      removalPolicy: removal,
      eventsTable,
      seatsTable,
      ordersTable,
      idempotencyTable,
    });
    const { orderQueue, orderDlq, createOrderFn } = orderAccept;

    const purchase = new PurchaseSaga(this, "Purchase", {
      stage,
      eventsTable,
      seatsTable,
      ordersTable,
      ledgerTable,
      orderQueue,
    });
    const {
      purchaseSaga,
      sagaStarterFn,
      mockPaymentUrl,
      verifyHoldFn,
      authorizePaymentFn,
      confirmSeatFn,
      capturePaymentFn,
      issueTicketFn,
      markConfirmedFn,
      releaseSeatFn,
      markFailedFn,
      voidAuthorizationFn,
      refundPaymentFn,
      markRefundedFn,
    } = purchase;

    const http = new HttpApi(this, "Http", {
      stage,
      eventsTable,
      seatsTable,
      holdSeatFn,
      createOrderFn,
    });
    const { api, healthFn } = http;

    new cdk.CfnOutput(this, "ApiUrl", {
      value: api.url,
      description: "API Gateway base URL",
    });
    new cdk.CfnOutput(this, "EventsTableName", {
      value: eventsTable.tableName,
    });
    new cdk.CfnOutput(this, "SeatsTableName", {
      value: seatsTable.tableName,
    });
    new cdk.CfnOutput(this, "HealthFunctionName", {
      value: healthFn.functionName,
    });
    new cdk.CfnOutput(this, "HoldSeatFunctionName", {
      value: holdSeatFn.functionName,
    });
    new cdk.CfnOutput(this, "HoldSweeperFunctionName", {
      value: holdSweeperFn.functionName,
    });
    new cdk.CfnOutput(this, "CreateOrderFunctionName", {
      value: createOrderFn.functionName,
    });
    new cdk.CfnOutput(this, "OrdersTableName", {
      value: ordersTable.tableName,
    });
    new cdk.CfnOutput(this, "IdempotencyTableName", {
      value: idempotencyTable.tableName,
    });
    new cdk.CfnOutput(this, "LedgerTableName", {
      value: ledgerTable.tableName,
    });
    new cdk.CfnOutput(this, "OrderQueueUrl", {
      value: orderQueue.queueUrl,
    });
    new cdk.CfnOutput(this, "OrderQueueArn", {
      value: orderQueue.queueArn,
    });
    new cdk.CfnOutput(this, "OrderDlqUrl", {
      value: orderDlq.queueUrl,
    });
    new cdk.CfnOutput(this, "PurchaseSagaArn", {
      value: purchaseSaga.stateMachineArn,
    });
    new cdk.CfnOutput(this, "SagaStarterFunctionName", {
      value: sagaStarterFn.functionName,
    });
    new cdk.CfnOutput(this, "VerifyHoldFunctionName", {
      value: verifyHoldFn.functionName,
    });
    new cdk.CfnOutput(this, "AuthorizePaymentFunctionName", {
      value: authorizePaymentFn.functionName,
    });
    new cdk.CfnOutput(this, "ConfirmSeatFunctionName", {
      value: confirmSeatFn.functionName,
    });
    new cdk.CfnOutput(this, "CapturePaymentFunctionName", {
      value: capturePaymentFn.functionName,
    });
    new cdk.CfnOutput(this, "IssueTicketFunctionName", {
      value: issueTicketFn.functionName,
    });
    new cdk.CfnOutput(this, "MarkConfirmedFunctionName", {
      value: markConfirmedFn.functionName,
    });
    new cdk.CfnOutput(this, "ReleaseSeatFunctionName", {
      value: releaseSeatFn.functionName,
    });
    new cdk.CfnOutput(this, "MarkFailedFunctionName", {
      value: markFailedFn.functionName,
    });
    new cdk.CfnOutput(this, "VoidAuthorizationFunctionName", {
      value: voidAuthorizationFn.functionName,
    });
    new cdk.CfnOutput(this, "RefundPaymentFunctionName", {
      value: refundPaymentFn.functionName,
    });
    new cdk.CfnOutput(this, "MarkRefundedFunctionName", {
      value: markRefundedFn.functionName,
    });
    new cdk.CfnOutput(this, "MockPaymentUrl", {
      value: mockPaymentUrl,
    });
  }
}
