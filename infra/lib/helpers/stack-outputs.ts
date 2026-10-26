import * as cdk from "aws-cdk-lib";
import type { DataPlane } from "../constructs/data-plane";
import type { HoldCapability } from "../constructs/hold-capability";
import type { HttpApi } from "../constructs/http-api";
import type { OrderAccept } from "../constructs/order-accept";
import type { PurchaseSaga } from "../constructs/purchase-saga";

/**
 * Stack-level CfnOutputs with stable IDs (ApiUrl, SeatsTableName, …)
 * so runbook / scripts keep reading the same keys from cdk-outputs.json.
 */
export function addGateholdOutputs(
  stack: cdk.Stack,
  parts: {
    data: DataPlane;
    holds: HoldCapability;
    orders: OrderAccept;
    purchase: PurchaseSaga;
    http: HttpApi;
  },
): void {
  const { data, holds, orders, purchase, http } = parts;

  new cdk.CfnOutput(stack, "ApiUrl", {
    value: http.api.url,
    description: "API Gateway base URL",
  });
  new cdk.CfnOutput(stack, "EventsTableName", {
    value: data.eventsTable.tableName,
  });
  new cdk.CfnOutput(stack, "SeatsTableName", {
    value: data.seatsTable.tableName,
  });
  new cdk.CfnOutput(stack, "HealthFunctionName", {
    value: http.healthFn.functionName,
  });
  new cdk.CfnOutput(stack, "HoldSeatFunctionName", {
    value: holds.holdSeatFn.functionName,
  });
  new cdk.CfnOutput(stack, "HoldSweeperFunctionName", {
    value: holds.holdSweeperFn.functionName,
  });
  new cdk.CfnOutput(stack, "CreateOrderFunctionName", {
    value: orders.createOrderFn.functionName,
  });
  new cdk.CfnOutput(stack, "OrdersTableName", {
    value: data.ordersTable.tableName,
  });
  new cdk.CfnOutput(stack, "IdempotencyTableName", {
    value: data.idempotencyTable.tableName,
  });
  new cdk.CfnOutput(stack, "LedgerTableName", {
    value: data.ledgerTable.tableName,
  });
  new cdk.CfnOutput(stack, "OrderQueueUrl", {
    value: orders.orderQueue.queueUrl,
  });
  new cdk.CfnOutput(stack, "OrderQueueArn", {
    value: orders.orderQueue.queueArn,
  });
  new cdk.CfnOutput(stack, "OrderDlqUrl", {
    value: orders.orderDlq.queueUrl,
  });
  new cdk.CfnOutput(stack, "PurchaseSagaArn", {
    value: purchase.purchaseSaga.stateMachineArn,
  });
  new cdk.CfnOutput(stack, "SagaStarterFunctionName", {
    value: purchase.sagaStarterFn.functionName,
  });
  new cdk.CfnOutput(stack, "VerifyHoldFunctionName", {
    value: purchase.verifyHoldFn.functionName,
  });
  new cdk.CfnOutput(stack, "AuthorizePaymentFunctionName", {
    value: purchase.authorizePaymentFn.functionName,
  });
  new cdk.CfnOutput(stack, "ConfirmSeatFunctionName", {
    value: purchase.confirmSeatFn.functionName,
  });
  new cdk.CfnOutput(stack, "CapturePaymentFunctionName", {
    value: purchase.capturePaymentFn.functionName,
  });
  new cdk.CfnOutput(stack, "IssueTicketFunctionName", {
    value: purchase.issueTicketFn.functionName,
  });
  new cdk.CfnOutput(stack, "MarkConfirmedFunctionName", {
    value: purchase.markConfirmedFn.functionName,
  });
  new cdk.CfnOutput(stack, "ReleaseSeatFunctionName", {
    value: purchase.releaseSeatFn.functionName,
  });
  new cdk.CfnOutput(stack, "MarkFailedFunctionName", {
    value: purchase.markFailedFn.functionName,
  });
  new cdk.CfnOutput(stack, "VoidAuthorizationFunctionName", {
    value: purchase.voidAuthorizationFn.functionName,
  });
  new cdk.CfnOutput(stack, "RefundPaymentFunctionName", {
    value: purchase.refundPaymentFn.functionName,
  });
  new cdk.CfnOutput(stack, "MarkRefundedFunctionName", {
    value: purchase.markRefundedFn.functionName,
  });
  new cdk.CfnOutput(stack, "MockPaymentUrl", {
    value: purchase.mockPaymentUrl,
  });
}
