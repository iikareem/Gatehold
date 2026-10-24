import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as targets from "aws-cdk-lib/aws-scheduler-targets";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";

export interface GateholdStackProps extends cdk.StackProps {
  stage: string;
}

/**
 * Phase 0–6 (partial) stack: Events + Seats + Orders + Idempotency + Ledger,
 * health + hold-seat + hold-sweeper + create-order, HTTP API,
 * EventBridge Scheduler → sweeper, order SQS (+ DLQ),
 * purchase saga (VerifyHold → Succeed) + saga-starter.
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

    // Phase 6 Slice 1a: append-only payment ledger (pk = provider idempotency key).
    // No writers yet — saga steps append AUTH/CAPTURE/VOID/REFUND in later slices.
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

    // Lambdas run in Docker under MiniStack; localhost/127.0.0.1 is the
    // container itself. Point SDKs at the emulator on the host.
    const lambdaEnv: Record<string, string> = {
      STAGE: stage,
      EVENTS_TABLE_NAME: eventsTable.tableName,
      SEATS_TABLE_NAME: seatsTable.tableName,
      ...(process.env.AWS_ENDPOINT_URL
        ? { AWS_ENDPOINT_URL: dockerReachableEndpoint(process.env.AWS_ENDPOINT_URL) }
        : {}),
    };

    const bundling = {
      minify: true,
      sourceMap: true,
      target: "node20",
    };
    const projectRoot = path.join(__dirname, "../..");

    const healthFn = new NodejsFunction(this, "HealthFn", {
      functionName: `gatehold-${stage}-health`,
      entry: path.join(__dirname, "../../services/health/src/handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: lambdaEnv,
      bundling,
      projectRoot,
    });

    const holdSeatFn = new NodejsFunction(this, "HoldSeatFn", {
      functionName: `gatehold-${stage}-hold-seat`,
      entry: path.join(__dirname, "../../services/hold-seat/src/handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: lambdaEnv,
      bundling,
      projectRoot,
    });

    const createOrderEnv: Record<string, string> = {
      ...lambdaEnv,
      ORDERS_TABLE_NAME: ordersTable.tableName,
      IDEMPOTENCY_TABLE_NAME: idempotencyTable.tableName,
      ORDER_QUEUE_URL: orderQueue.queueUrl,
    };

    const createOrderFn = new NodejsFunction(this, "CreateOrderFn", {
      functionName: `gatehold-${stage}-create-order`,
      entry: path.join(__dirname, "../../services/create-order/src/handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: createOrderEnv,
      bundling,
      projectRoot,
    });

    // Go custom runtime: zip built by `npm run build:hold-sweeper` (bootstrap).
    const holdSweeperFn = new lambda.Function(this, "HoldSweeperFn", {
      functionName: `gatehold-${stage}-hold-sweeper`,
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      handler: "bootstrap",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../../go/hold-sweeper/dist/hold-sweeper.zip"),
      ),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: lambdaEnv,
    });

    // Phase 6 Slice 2: VerifyHold (real checks) + purchase saga skeleton end.
    const verifyHoldFn = new NodejsFunction(this, "VerifyHoldFn", {
      functionName: `gatehold-${stage}-verify-hold`,
      entry: path.join(
        __dirname,
        "../../services/saga-steps/src/verify-hold.ts",
      ),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        ...lambdaEnv,
        ORDERS_TABLE_NAME: ordersTable.tableName,
      },
      bundling,
      projectRoot,
    });

    const verifyHoldTask = new tasks.LambdaInvoke(this, "VerifyHold", {
      lambdaFunction: verifyHoldFn,
      outputPath: "$.Payload",
      retryOnServiceExceptions: true,
    });
    // Retry only transient DynamoDB/infra errors thrown as TransientError.
    // VerifyHoldError (business fail) is not listed → fails the execution.
    verifyHoldTask.addRetry({
      errors: ["TransientError"],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 3,
      backoffRate: 2,
    });

    const sagaDefinition = verifyHoldTask.next(
      new sfn.Succeed(this, "SagaSkeletonDone"),
    );
    const purchaseSaga = new sfn.StateMachine(this, "PurchaseSaga", {
      stateMachineName: `gatehold-${stage}-purchase-saga`,
      definitionBody: sfn.DefinitionBody.fromChainable(sagaDefinition),
      tracingEnabled: false,
    });

    const sagaStarterFn = new NodejsFunction(this, "SagaStarterFn", {
      functionName: `gatehold-${stage}-saga-starter`,
      entry: path.join(
        __dirname,
        "../../services/saga-starter/src/handler.ts",
      ),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ...lambdaEnv,
        ORDERS_TABLE_NAME: ordersTable.tableName,
        PURCHASE_SAGA_ARN: purchaseSaga.stateMachineArn,
      },
      bundling,
      projectRoot,
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

    // Timer only (not the Phase 7 domain event bus).
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

    // POST /orders → create-order Lambda (handler stub until Phase 4 logic)
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
  }
}

/**
 * Rewrite local emulator hosts so Lambda containers can reach MiniStack on the host.
 * `localhost`, `127.0.0.1`, and `*.localstack.cloud` all resolve to loopback inside
 * the container and must become `host.docker.internal` instead.
 */
function dockerReachableEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const host = url.hostname;
    const isLoopback =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host.endsWith(".localstack.cloud") ||
      host === "ministack";
    if (isLoopback) {
      url.hostname = "host.docker.internal";
      url.port = url.port || "4566";
      return url.toString().replace(/\/$/, "");
    }
  } catch {
    // leave as-is
  }
  return endpoint;
}
