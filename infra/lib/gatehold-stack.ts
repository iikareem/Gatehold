import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import { Construct } from "constructs";
import { DataPlane } from "./constructs/data-plane";
import { HoldCapability } from "./constructs/hold-capability";
import { OrderAccept } from "./constructs/order-accept";
import { PurchaseSaga } from "./constructs/purchase-saga";
import {
  baseLambdaEnv,
  createNodeFn,
  projectRoot,
} from "./helpers/node-fn";

export interface GateholdStackProps extends cdk.StackProps {
  stage: string;
}

/**
 * Phase 0–6 stack + Phase 7 slices 0–4:
 * DataPlane, HoldCapability, OrderAccept, PurchaseSaga,
 * health + HTTP API (Slice 5 will extract HttpApi).
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

    const lambdaEnv = baseLambdaEnv(stage, {
      eventsTableName: eventsTable.tableName,
      seatsTableName: seatsTable.tableName,
    });

    const healthFn = createNodeFn(this, "HealthFn", {
      stage,
      name: "health",
      entry: path.join(projectRoot, "services/health/src/handler.ts"),
      environment: lambdaEnv,
    });

    eventsTable.grantReadData(healthFn);
    seatsTable.grantReadData(healthFn);

    const api = new apigateway.RestApi(this, "GateholdApi", {
      restApiName: `gatehold-${stage}`,
      deployOptions: { stageName: stage },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ["GET", "POST", "OPTIONS"],
      },
    });

    const health = api.root.addResource("health");
    health.addMethod("GET", new apigateway.LambdaIntegration(healthFn));

    // POST /events/{eventId}/holds → hold-seat Lambda
    const events = api.root.addResource("events");
    const eventById = events.addResource("{eventId}");
    const holds = eventById.addResource("holds");
    holds.addMethod("POST", new apigateway.LambdaIntegration(holdSeatFn));

    // POST /orders → create-order Lambda
    const orders = api.root.addResource("orders");
    orders.addMethod("POST", new apigateway.LambdaIntegration(createOrderFn));

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
