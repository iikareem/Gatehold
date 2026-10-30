import * as cdk from "aws-cdk-lib";
import type { Auth } from "../constructs/auth";
import type { Config } from "../constructs/config";
import type { DataPlane } from "../constructs/data-plane";
import type { DomainEvents } from "../constructs/domain-events";
import type { HoldCapability } from "../constructs/hold-capability";
import type { HttpApi } from "../constructs/http-api";
import type { OrderAccept } from "../constructs/order-accept";
import type { PurchaseSaga } from "../constructs/purchase-saga";
import type { TicketStore } from "../constructs/ticket-store";

/**
 * Stack-level CfnOutputs with stable IDs (ApiUrl, SeatsTableName, …)
 * so runbook / scripts keep reading the same keys from cdk-outputs.json.
 */
export function addGateholdOutputs(
  stack: cdk.Stack,
  parts: {
    data: DataPlane;
    config: Config;
    auth: Auth;
    holds: HoldCapability;
    orders: OrderAccept;
    purchase: PurchaseSaga;
    http: HttpApi;
    domainEvents: DomainEvents;
    tickets: TicketStore;
  },
): void {
  const {
    data,
    config,
    auth,
    holds,
    orders,
    purchase,
    http,
    domainEvents,
    tickets,
  } = parts;

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
  new cdk.CfnOutput(stack, "MockPaymentSecretArn", {
    value: config.mockPaymentSecret.secretArn,
    description: "Secrets Manager ARN for mock-payment URL (payment Lambdas GetSecretValue)",
  });
  new cdk.CfnOutput(stack, "MockPaymentSecretUrl", {
    value: config.mockPaymentUrl,
    description: "URL seeded into MockPaymentSecret",
  });
  new cdk.CfnOutput(stack, "HoldTtlMsParamName", {
    value: config.holdTtlMsParamName,
    description: "SSM parameter for hold TTL ms (hold-seat GetParameter)",
  });
  new cdk.CfnOutput(stack, "MaxHoldSeatsParamName", {
    value: config.maxHoldSeatsParamName,
    description: "SSM parameter for max seats (hold-seat + create-order GetParameter)",
  });
  new cdk.CfnOutput(stack, "RefundRateParamName", {
    value: config.refundRateParamName,
    description: "SSM parameter for refund rate (Phase 11 stub — no consumer yet)",
  });
  new cdk.CfnOutput(stack, "StreamRelayFunctionName", {
    value: domainEvents.streamRelayFn.functionName,
  });
  new cdk.CfnOutput(stack, "DomainEventBusName", {
    value: domainEvents.eventBus.eventBusName,
  });
  new cdk.CfnOutput(stack, "OrderConfirmedLoggerFunctionName", {
    value: domainEvents.orderConfirmedLoggerFn.functionName,
  });
  new cdk.CfnOutput(stack, "OrderNotificationsTopicArn", {
    value: domainEvents.orderNotificationsTopic.topicArn,
  });
  new cdk.CfnOutput(stack, "OrderNotificationsQueueUrl", {
    value: domainEvents.orderNotificationsQueue.queueUrl,
  });
  new cdk.CfnOutput(stack, "OrderNotificationsDlqUrl", {
    value: domainEvents.orderNotificationsDlq.queueUrl,
  });
  new cdk.CfnOutput(stack, "NotifyEmailFunctionName", {
    value: domainEvents.notifyEmailFn.functionName,
  });
  new cdk.CfnOutput(stack, "UserPoolId", {
    value: auth.userPool.userPoolId,
    description: "Cognito user pool id (Phase 9a)",
  });
  new cdk.CfnOutput(stack, "UserPoolClientId", {
    value: auth.userPoolClient.userPoolClientId,
    description: "Cognito app client id for InitiateAuth",
  });
  new cdk.CfnOutput(stack, "UserPoolIssuer", {
    value: auth.issuerUrl,
    description: "JWT iss claim / OIDC issuer URL",
  });
  new cdk.CfnOutput(stack, "TicketsBucketName", {
    value: tickets.ticketsBucket.bucketName,
    description: "S3 bucket for signed ticket artifacts (Phase 10a)",
  });
  new cdk.CfnOutput(stack, "TicketSigningKeyId", {
    value: tickets.signingKey.keyId,
    description: "KMS key id for ticket Sign/Verify (Phase 10a)",
  });
  new cdk.CfnOutput(stack, "TicketSigningKeyArn", {
    value: tickets.signingKey.keyArn,
    description: "KMS key ARN for ticket Sign/Verify (Phase 10a)",
  });
}
