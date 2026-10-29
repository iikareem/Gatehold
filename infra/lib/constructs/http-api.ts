import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cognito from "aws-cdk-lib/aws-cognito";
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
  /** Cognito pool used by the REST Cognito authorizer (Phase 9b). */
  userPool: cognito.IUserPool;
}

/**
 * HTTP edge: health Lambda + RestApi routes for health, holds, and orders.
 *
 * Creates health (and its table grants). Wires hold-seat / create-order from
 * sibling constructs via Lambda integrations. Exposes `api` and `healthFn`.
 * Holds/orders require Cognito JWT; health stays open.
 */
export class HttpApi extends Construct {
  readonly api: apigateway.RestApi;
  readonly healthFn: lambda.IFunction;
  readonly cognitoAuthorizer: apigateway.CognitoUserPoolsAuthorizer;

  constructor(scope: Construct, id: string, props: HttpApiProps) {
    super(scope, id);

    const {
      stage,
      eventsTable,
      seatsTable,
      holdSeatFn,
      createOrderFn,
      userPool,
    } = props;

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
        allowHeaders: [
          ...apigateway.Cors.DEFAULT_HEADERS,
          "Authorization",
          "Idempotency-Key",
        ],
      },
    });

    this.cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      "CognitoAuthorizer",
      {
        cognitoUserPools: [userPool],
        authorizerName: `gatehold-${stage}-cognito`,
        identitySource: "method.request.header.Authorization",
        // No cache while learning / MiniStack — always re-check the Bearer token.
        resultsCacheTtl: cdk.Duration.seconds(0),
      },
    );

    const protectedMethodOptions: apigateway.MethodOptions = {
      authorizer: this.cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    const health = this.api.root.addResource("health");
    health.addMethod(
      "GET",
      new apigateway.LambdaIntegration(this.healthFn),
    );

    // POST /events/{eventId}/holds → hold-seat Lambda (Cognito JWT required)
    const events = this.api.root.addResource("events");
    const eventById = events.addResource("{eventId}");
    const holds = eventById.addResource("holds");
    holds.addMethod(
      "POST",
      new apigateway.LambdaIntegration(holdSeatFn),
      protectedMethodOptions,
    );

    // POST /orders → create-order Lambda (Cognito JWT required)
    const orders = this.api.root.addResource("orders");
    orders.addMethod(
      "POST",
      new apigateway.LambdaIntegration(createOrderFn),
      protectedMethodOptions,
    );
  }
}
