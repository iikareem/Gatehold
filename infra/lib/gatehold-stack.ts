import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as targets from "aws-cdk-lib/aws-scheduler-targets";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import { Construct } from "constructs";
import {
  baseLambdaEnv,
  createNodeFn,
  dockerReachableEndpoint,
  projectRoot,
} from "./helpers/node-fn";
import { createSagaTask } from "./helpers/saga-task";

export interface GateholdStackProps extends cdk.StackProps {
  stage: string;
}

/**
 * Phase 0–6 stack + Phase 7 Slice 0 helpers:
 * Events + Seats + Orders + Idempotency + Ledger,
 * health + hold-seat + hold-sweeper + create-order, HTTP API,
 * EventBridge Scheduler → sweeper, order SQS (+ DLQ),
 * purchase saga + saga-starter.
 * Shared NodejsFunction / saga-task defaults live in helpers/.
 */
export class GateholdStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GateholdStackProps) {
    super(scope, id, props);

    const { stage } = props;
    const removal =
      stage === "prod"
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY;

    const eventsTable = new dynamodb.Table(this, "EventsTable", {
      tableName: `gatehold-${stage}-events`,
      partitionKey: { name: "eventId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: removal,
    });

    const seatsTable = new dynamodb.Table(this, "SeatsTable", {
      tableName: `gatehold-${stage}-seats`,
      partitionKey: { name: "eventId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "seatId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: removal,
    });

    // Phase 4: Orders + Idempotency + order queue (+ create-order below).
    const ordersTable = new dynamodb.Table(this, "OrdersTable", {
      tableName: `gatehold-${stage}-orders`,
      partitionKey: { name: "orderId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: removal,
    });
    ordersTable.addGlobalSecondaryIndex({
      indexName: "userId",
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    ordersTable.addGlobalSecondaryIndex({
      indexName: "eventId-status",
      partitionKey: { name: "eventId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "status", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const idempotencyTable = new dynamodb.Table(this, "IdempotencyTable", {
      tableName: `gatehold-${stage}-idempotency`,
      partitionKey: { name: "key", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: removal,
      timeToLiveAttribute: "ttl",
    });

    // Phase 6: append-only payment ledger (pk = provider idempotency key).
    const ledgerTable = new dynamodb.Table(this, "LedgerTable", {
      tableName: `gatehold-${stage}-ledger`,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: removal,
    });

    const orderDlq = new sqs.Queue(this, "OrderDlq", {
      queueName: `gatehold-${stage}-orders-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy: removal,
    });
    const orderQueue = new sqs.Queue(this, "OrderQueue", {
      queueName: `gatehold-${stage}-orders`,
      // Must exceed saga-starter timeout (SFN start + order update).
      visibilityTimeout: cdk.Duration.seconds(90),
      retentionPeriod: cdk.Duration.days(4),
      removalPolicy: removal,
      deadLetterQueue: {
        queue: orderDlq,
        maxReceiveCount: 5,
      },
    });

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

    const holdSeatFn = createNodeFn(this, "HoldSeatFn", {
      stage,
      name: "hold-seat",
      entry: path.join(projectRoot, "services/hold-seat/src/handler.ts"),
      environment: lambdaEnv,
    });

    const createOrderFn = createNodeFn(this, "CreateOrderFn", {
      stage,
      name: "create-order",
      entry: path.join(projectRoot, "services/create-order/src/handler.ts"),
      environment: {
        ...lambdaEnv,
        ORDERS_TABLE_NAME: ordersTable.tableName,
        IDEMPOTENCY_TABLE_NAME: idempotencyTable.tableName,
        ORDER_QUEUE_URL: orderQueue.queueUrl,
      },
    });

    // Go custom runtime: zip built by `npm run build:hold-sweeper` (bootstrap).
    const holdSweeperFn = new lambda.Function(this, "HoldSweeperFn", {
      functionName: `gatehold-${stage}-hold-sweeper`,
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      handler: "bootstrap",
      code: lambda.Code.fromAsset(
        path.join(projectRoot, "go/hold-sweeper/dist/hold-sweeper.zip"),
      ),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: lambdaEnv,
    });

    // Phase 6 happy path:
    // VerifyHold → AuthorizePayment → ConfirmSeat → CapturePayment
    // → IssueTicket → MarkConfirmed → Succeed
    // AuthorizePayment Catch → ReleaseSeat → MarkFailed → SagaCompensated
    // ConfirmSeat / CapturePayment Catch → VoidAuthorization → (same) ReleaseSeat → …
    // IssueTicket / MarkConfirmed Catch → RefundPayment → ReleaseSeat → MarkRefunded
    // (Slice 3 LockSeat assert still pending).
    const verifyHoldFn = createNodeFn(this, "VerifyHoldFn", {
      stage,
      name: "verify-hold",
      entry: path.join(projectRoot, "services/saga-steps/src/verify-hold.ts"),
      environment: {
        ...lambdaEnv,
        ORDERS_TABLE_NAME: ordersTable.tableName,
      },
    });

    const mockPaymentUrl = dockerReachableEndpoint(
      process.env.MOCK_PAYMENT_URL || "http://127.0.0.1:8090",
    );
    const authorizePaymentFn = createNodeFn(this, "AuthorizePaymentFn", {
      stage,
      name: "authorize-payment",
      entry: path.join(
        projectRoot,
        "services/saga-steps/src/authorize-payment.ts",
      ),
      timeout: cdk.Duration.seconds(15),
      environment: {
        ...lambdaEnv,
        ORDERS_TABLE_NAME: ordersTable.tableName,
        LEDGER_TABLE_NAME: ledgerTable.tableName,
        MOCK_PAYMENT_URL: mockPaymentUrl,
        ORDER_AMOUNT_CENTS: process.env.ORDER_AMOUNT_CENTS || String(5000),
      },
    });

    const verifyHoldTask = createSagaTask(this, "VerifyHold", verifyHoldFn);

    const confirmSeatFn = createNodeFn(this, "ConfirmSeatFn", {
      stage,
      name: "confirm-seat",
      entry: path.join(projectRoot, "services/saga-steps/src/confirm-seat.ts"),
      environment: lambdaEnv,
    });

    const capturePaymentFn = createNodeFn(this, "CapturePaymentFn", {
      stage,
      name: "capture-payment",
      entry: path.join(projectRoot, "services/saga-steps/src/capture-payment.ts"),
      timeout: cdk.Duration.seconds(15),
      environment: {
        ...lambdaEnv,
        LEDGER_TABLE_NAME: ledgerTable.tableName,
        MOCK_PAYMENT_URL: mockPaymentUrl,
      },
    });

    const authorizePaymentTask = createSagaTask(
      this,
      "AuthorizePayment",
      authorizePaymentFn,
    );

    const releaseSeatFn = createNodeFn(this, "ReleaseSeatFn", {
      stage,
      name: "release-seat",
      entry: path.join(projectRoot, "services/saga-steps/src/release-seat.ts"),
      environment: lambdaEnv,
    });

    const markFailedFn = createNodeFn(this, "MarkFailedFn", {
      stage,
      name: "mark-failed",
      entry: path.join(projectRoot, "services/saga-steps/src/mark-failed.ts"),
      environment: {
        ...lambdaEnv,
        ORDERS_TABLE_NAME: ordersTable.tableName,
      },
    });

    const releaseSeatTask = createSagaTask(this, "ReleaseSeat", releaseSeatFn);
    const markFailedTask = createSagaTask(this, "MarkFailed", markFailedFn);

    const sagaCompensated = new sfn.Succeed(this, "SagaCompensated");
    // Shared compensation tail (one ReleaseSeat / MarkFailed graph).
    const releaseThenFail = releaseSeatTask
      .next(markFailedTask)
      .next(sagaCompensated);

    // Auth never succeeded → no void; free seats + mark order FAILED.
    authorizePaymentTask.addCatch(releaseThenFail, {
      errors: ["States.ALL"],
      resultPath: "$.error",
    });

    const voidAuthorizationFn = createNodeFn(this, "VoidAuthorizationFn", {
      stage,
      name: "void-authorization",
      entry: path.join(
        projectRoot,
        "services/saga-steps/src/void-authorization.ts",
      ),
      timeout: cdk.Duration.seconds(15),
      environment: {
        ...lambdaEnv,
        LEDGER_TABLE_NAME: ledgerTable.tableName,
        MOCK_PAYMENT_URL: mockPaymentUrl,
      },
    });

    const voidAuthorizationTask = createSagaTask(
      this,
      "VoidAuthorization",
      voidAuthorizationFn,
    );

    // Auth succeeded but ConfirmSeat or Capture failed → void first, then same tail.
    // Capture never took money; seats may be PAYING (confirm fail) or SOLD (capture fail).
    const voidThenRelease = voidAuthorizationTask.next(releaseSeatTask);

    const confirmSeatTask = createSagaTask(this, "ConfirmSeat", confirmSeatFn);
    confirmSeatTask.addCatch(voidThenRelease, {
      errors: ["States.ALL"],
      resultPath: "$.error",
    });

    const capturePaymentTask = createSagaTask(
      this,
      "CapturePayment",
      capturePaymentFn,
    );
    capturePaymentTask.addCatch(voidThenRelease, {
      errors: ["States.ALL"],
      resultPath: "$.error",
    });

    const issueTicketFn = createNodeFn(this, "IssueTicketFn", {
      stage,
      name: "issue-ticket",
      entry: path.join(projectRoot, "services/saga-steps/src/issue-ticket.ts"),
      environment: {
        ...lambdaEnv,
        ORDERS_TABLE_NAME: ordersTable.tableName,
      },
    });

    const markConfirmedFn = createNodeFn(this, "MarkConfirmedFn", {
      stage,
      name: "mark-confirmed",
      entry: path.join(projectRoot, "services/saga-steps/src/mark-confirmed.ts"),
      environment: {
        ...lambdaEnv,
        ORDERS_TABLE_NAME: ordersTable.tableName,
      },
    });

    const refundPaymentFn = createNodeFn(this, "RefundPaymentFn", {
      stage,
      name: "refund-payment",
      entry: path.join(projectRoot, "services/saga-steps/src/refund-payment.ts"),
      timeout: cdk.Duration.seconds(15),
      environment: {
        ...lambdaEnv,
        LEDGER_TABLE_NAME: ledgerTable.tableName,
        MOCK_PAYMENT_URL: mockPaymentUrl,
      },
    });

    const markRefundedFn = createNodeFn(this, "MarkRefundedFn", {
      stage,
      name: "mark-refunded",
      entry: path.join(projectRoot, "services/saga-steps/src/mark-refunded.ts"),
      environment: {
        ...lambdaEnv,
        ORDERS_TABLE_NAME: ordersTable.tableName,
      },
    });

    const refundPaymentTask = createSagaTask(
      this,
      "RefundPayment",
      refundPaymentFn,
    );

    // Separate ReleaseSeat state: void path ends at MarkFailed; refund ends at MarkRefunded.
    const releaseSeatAfterRefundTask = createSagaTask(
      this,
      "ReleaseSeatAfterRefund",
      releaseSeatFn,
    );

    const markRefundedTask = createSagaTask(
      this,
      "MarkRefunded",
      markRefundedFn,
    );

    // Capture succeeded but IssueTicket / MarkConfirmed failed → refund money, free seats.
    const refundThenRelease = refundPaymentTask
      .next(releaseSeatAfterRefundTask)
      .next(markRefundedTask)
      .next(sagaCompensated);

    const issueTicketTask = createSagaTask(this, "IssueTicket", issueTicketFn);
    issueTicketTask.addCatch(refundThenRelease, {
      errors: ["States.ALL"],
      resultPath: "$.error",
    });

    const markConfirmedTask = createSagaTask(
      this,
      "MarkConfirmed",
      markConfirmedFn,
    );
    markConfirmedTask.addCatch(refundThenRelease, {
      errors: ["States.ALL"],
      resultPath: "$.error",
    });

    const sagaDefinition = verifyHoldTask
      .next(authorizePaymentTask)
      .next(confirmSeatTask)
      .next(capturePaymentTask)
      .next(issueTicketTask)
      .next(markConfirmedTask)
      .next(new sfn.Succeed(this, "SagaHappyPathDone"));
    const purchaseSaga = new sfn.StateMachine(this, "PurchaseSaga", {
      stateMachineName: `gatehold-${stage}-purchase-saga`,
      definitionBody: sfn.DefinitionBody.fromChainable(sagaDefinition),
      tracingEnabled: false,
    });

    const sagaStarterFn = createNodeFn(this, "SagaStarterFn", {
      stage,
      name: "saga-starter",
      entry: path.join(projectRoot, "services/saga-starter/src/handler.ts"),
      timeout: cdk.Duration.seconds(30),
      environment: {
        ...lambdaEnv,
        ORDERS_TABLE_NAME: ordersTable.tableName,
        PURCHASE_SAGA_ARN: purchaseSaga.stateMachineArn,
      },
    });
    sagaStarterFn.addEventSource(
      new SqsEventSource(orderQueue, {
        batchSize: 5,
        reportBatchItemFailures: true,
      }),
    );

    eventsTable.grantReadData(healthFn);
    seatsTable.grantReadData(healthFn);
    seatsTable.grantReadWriteData(holdSeatFn);
    seatsTable.grantReadWriteData(holdSweeperFn);

    eventsTable.grantReadData(createOrderFn);
    seatsTable.grantReadWriteData(createOrderFn);
    ordersTable.grantReadWriteData(createOrderFn);
    idempotencyTable.grantReadWriteData(createOrderFn);
    orderQueue.grantSendMessages(createOrderFn);

    ordersTable.grantReadWriteData(sagaStarterFn);
    purchaseSaga.grantStartExecution(sagaStarterFn);

    eventsTable.grantReadData(verifyHoldFn);
    seatsTable.grantReadData(verifyHoldFn);
    ordersTable.grantReadData(verifyHoldFn);

    ledgerTable.grantReadWriteData(authorizePaymentFn);
    ordersTable.grantReadWriteData(authorizePaymentFn);

    seatsTable.grantReadWriteData(confirmSeatFn);
    seatsTable.grantReadWriteData(releaseSeatFn);

    ledgerTable.grantReadWriteData(capturePaymentFn);
    ledgerTable.grantReadWriteData(voidAuthorizationFn);
    ledgerTable.grantReadWriteData(refundPaymentFn);

    ordersTable.grantReadWriteData(issueTicketFn);
    ordersTable.grantReadWriteData(markConfirmedFn);
    ordersTable.grantReadWriteData(markFailedFn);
    ordersTable.grantReadWriteData(markRefundedFn);

    // Timer only (not the Phase 8 domain event bus).
    new scheduler.Schedule(this, "HoldSweeperSchedule", {
      scheduleName: `gatehold-${stage}-hold-sweeper`,
      description: "Release expired HELD seats (hold-sweeper)",
      schedule: scheduler.ScheduleExpression.rate(cdk.Duration.minutes(1)),
      target: new targets.LambdaInvoke(holdSweeperFn),
    });

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
