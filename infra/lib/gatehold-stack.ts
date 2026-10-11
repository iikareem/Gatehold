import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

export interface GateholdStackProps extends cdk.StackProps {
  stage: string;
}

/**
 * Phase 0–1 stack: Events + Seats tables, health + hold-seat Lambdas, HTTP API.
 * Later phases add Cognito, group holds, SQS, Step Functions, refunds.
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

    eventsTable.grantReadData(healthFn);
    seatsTable.grantReadData(healthFn);
    seatsTable.grantReadWriteData(holdSeatFn);

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
