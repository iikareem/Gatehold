import * as path from "path";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import {
  baseLambdaEnv,
  createNodeFn,
  projectRoot,
} from "../helpers/node-fn";

export interface HttpApiProps {
  stage: string;
  eventsTable: dynamodb.ITable;
  seatsTable: dynamodb.ITable;
  holdSeatFn: lambda.IFunction;
  createOrderFn: lambda.IFunction;
}

/**
 * HTTP edge: health Lambda + RestApi routes for health, holds, and orders.
 *
 * Creates health (and its table grants). Wires hold-seat / create-order from
 * sibling constructs via Lambda integrations. Exposes `api` and `healthFn`.
 */
export class HttpApi extends Construct {
  readonly api: apigateway.RestApi;
  readonly healthFn: lambda.IFunction;

  constructor(scope: Construct, id: string, props: HttpApiProps) {
    super(scope, id);

    const { stage, eventsTable, seatsTable, holdSeatFn, createOrderFn } =
      props;

    const lambdaEnv = baseLambdaEnv(stage, {
      eventsTableName: eventsTable.tableName,
      seatsTableName: seatsTable.tableName,
    });

    this.healthFn = createNodeFn(this, "HealthFn", {
      stage,
      name: "health",
      entry: path.join(projectRoot, "services/health/src/handler.ts"),
      environment: lambdaEnv,
    });

    eventsTable.grantReadData(this.healthFn);
    seatsTable.grantReadData(this.healthFn);

    this.api = new apigateway.RestApi(this, "GateholdApi", {
      restApiName: `gatehold-${stage}`,
      deployOptions: { stageName: stage },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ["GET", "POST", "OPTIONS"],
      },
    });

    const health = this.api.root.addResource("health");
    health.addMethod(
      "GET",
      new apigateway.LambdaIntegration(this.healthFn),
    );

    // POST /events/{eventId}/holds → hold-seat Lambda
    const events = this.api.root.addResource("events");
    const eventById = events.addResource("{eventId}");
    const holds = eventById.addResource("holds");
    holds.addMethod("POST", new apigateway.LambdaIntegration(holdSeatFn));

    // POST /orders → create-order Lambda
    const orders = this.api.root.addResource("orders");
    orders.addMethod("POST", new apigateway.LambdaIntegration(createOrderFn));
  }
}
