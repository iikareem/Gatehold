import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { ADMIN_GROUP_NAME } from "./auth";
import {
  baseLambdaEnv,
  createNodeFn,
  dockerReachableEndpoint,
  projectRoot,
} from "../helpers/node-fn";

export interface HttpApiProps {
  stage: string;
  eventsTable: dynamodb.ITable;
  seatsTable: dynamodb.ITable;
  holdSeatFn: lambda.IFunction;
  createOrderFn: lambda.IFunction;
  /** Phase 10c — GET /orders/{orderId} (owner + ticket presign). */
  getOrderFn: lambda.IFunction;
  /** Phase 10d — ticket SIGN_VERIFY key for POST /tickets/verify. */
  ticketSigningKey: kms.IKey;
  /** Cognito pool used by the REST Cognito authorizer (Phase 9b). */
  userPool: cognito.IUserPool;
  /** App client id — IdToken `aud` checked by the admin authorizer (9c). */
  userPoolClient: cognito.IUserPoolClient;
  /** Issuer URL (`iss` claim). */
  userPoolIssuer: string;
}

/**
 * HTTP edge: health Lambda + RestApi routes for health, holds, orders, admin.
 *
 * Holds/orders: Cognito JWT authorizer (any signed-in user).
 * Admin routes: TOKEN Lambda authorizer (JWT + `admin` group) — deny before stubs.
 * Health + ticket verify stay open (gate uses crypto, not fan JWT).
 */
export class HttpApi extends Construct {
  readonly api: apigateway.RestApi;
  readonly healthFn: lambda.IFunction;
  readonly verifyTicketFn: lambda.IFunction;
  readonly cognitoAuthorizer: apigateway.CognitoUserPoolsAuthorizer;
  readonly adminAuthorizerFn: lambda.IFunction;
  readonly adminAuthorizer: apigateway.TokenAuthorizer;
  readonly cancelFn: lambda.IFunction;
  readonly refundsFn: lambda.IFunction;

  constructor(scope: Construct, id: string, props: HttpApiProps) {
    super(scope, id);

    const {
      stage,
      eventsTable,
      seatsTable,
      holdSeatFn,
      createOrderFn,
      getOrderFn,
      ticketSigningKey,
      userPool,
      userPoolClient,
      userPoolIssuer,
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

    // health only GetItem on seats (?eventId=&seatId=); events table unused.
    seatsTable.grantReadData(this.healthFn);

    // Phase 10d — simulated gate: KMS.Verify + event not CANCELLED.
    this.verifyTicketFn = createNodeFn(this, "VerifyTicketFn", {
      stage,
      name: "verify-ticket",
      entry: path.join(projectRoot, "services/verify-ticket/src/handler.ts"),
      environment: {
        STAGE: stage,
        EVENTS_TABLE_NAME: eventsTable.tableName,
        TICKET_SIGNING_KEY_ID: ticketSigningKey.keyId,
        ...(process.env.AWS_ENDPOINT_URL
          ? {
              AWS_ENDPOINT_URL: dockerReachableEndpoint(
                process.env.AWS_ENDPOINT_URL,
              ),
            }
          : {}),
      },
    });
    eventsTable.grantReadData(this.verifyTicketFn);
    ticketSigningKey.grant(this.verifyTicketFn, "kms:Verify");

    this.adminAuthorizerFn = createNodeFn(this, "AdminAuthorizerFn", {
      stage,
      name: "admin-authorizer",
      entry: path.join(projectRoot, "services/admin-authorizer/src/handler.ts"),
      environment: {
        STAGE: stage,
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
        USER_POOL_ISSUER: userPoolIssuer,
        ADMIN_GROUP_NAME,
        ...(process.env.AWS_ENDPOINT_URL
          ? {
              AWS_ENDPOINT_URL: dockerReachableEndpoint(
                process.env.AWS_ENDPOINT_URL,
              ),
            }
          : {}),
      },
    });

    // Phase 11b — admin cancel: ON_SALE → CANCELLING.
    this.cancelFn = createNodeFn(this, "CancelFn", {
      stage,
      name: "cancel",
      entry: path.join(projectRoot, "services/cancel/src/handler.ts"),
      environment: {
        STAGE: stage,
        EVENTS_TABLE_NAME: eventsTable.tableName,
        ...(process.env.AWS_ENDPOINT_URL
          ? {
              AWS_ENDPOINT_URL: dockerReachableEndpoint(
                process.env.AWS_ENDPOINT_URL,
              ),
            }
          : {}),
      },
    });
    eventsTable.grantWriteData(this.cancelFn);

    this.refundsFn = createNodeFn(this, "RefundsFn", {
      stage,
      name: "refunds",
      entry: path.join(projectRoot, "services/refunds/src/handler.ts"),
      environment: { STAGE: stage },
    });

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

    this.adminAuthorizer = new apigateway.TokenAuthorizer(
      this,
      "AdminAuthorizer",
      {
        handler: this.adminAuthorizerFn,
        authorizerName: `gatehold-${stage}-admin`,
        identitySource: "method.request.header.Authorization",
        resultsCacheTtl: cdk.Duration.seconds(0),
      },
    );

    const signedInMethodOptions: apigateway.MethodOptions = {
      authorizer: this.cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    const cancelRefundAuth: apigateway.MethodOptions = {
      authorizer: this.adminAuthorizer,
      authorizationType: apigateway.AuthorizationType.CUSTOM,
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
      signedInMethodOptions,
    );

    // POST /orders → create-order; GET /orders/{orderId} → get-order (Cognito)
    const orders = this.api.root.addResource("orders");
    orders.addMethod(
      "POST",
      new apigateway.LambdaIntegration(createOrderFn),
      signedInMethodOptions,
    );
    const orderById = orders.addResource("{orderId}");
    orderById.addMethod(
      "GET",
      new apigateway.LambdaIntegration(getOrderFn),
      signedInMethodOptions,
    );

    // POST /tickets/verify — open (simulated gate; trust is signature + event)
    const tickets = this.api.root.addResource("tickets");
    tickets
      .addResource("verify")
      .addMethod(
        "POST",
        new apigateway.LambdaIntegration(this.verifyTicketFn),
      );

    // /admin/* (9c) — JWT + admin group at the edge; cancel/refund stubs until Phase 11
    const adminRoot = this.api.root.addResource("admin");
    const adminEvents = adminRoot.addResource("events");
    const adminEvent = adminEvents.addResource("{eventId}");
    adminEvent
      .addResource("cancel")
      .addMethod(
        "POST",
        new apigateway.LambdaIntegration(this.cancelFn),
        cancelRefundAuth,
      );
    adminEvent
      .addResource("refunds")
      .addMethod(
        "GET",
        new apigateway.LambdaIntegration(this.refundsFn),
        cancelRefundAuth,
      );
  }
}
