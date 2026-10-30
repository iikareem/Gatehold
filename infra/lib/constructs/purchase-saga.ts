import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import { Construct } from "constructs";
import { grantTableWriteWithTransact } from "../helpers/iam-grants";
import {
  baseLambdaEnv,
  createNodeFn,
  projectRoot,
} from "../helpers/node-fn";
import { createSagaTask } from "../helpers/saga-task";

export interface PurchaseSagaProps {
  stage: string;
  eventsTable: dynamodb.ITable;
  seatsTable: dynamodb.ITable;
  ordersTable: dynamodb.ITable;
  ledgerTable: dynamodb.ITable;
  /** Order accept queue — saga-starter consumes from it. */
  orderQueue: sqs.IQueue;
  /** Mock payment URL secret (Phase 9d.2). */
  mockPaymentSecret: secretsmanager.ISecret;
  /** Seeded URL for stack outputs (value also lives in the secret). */
  mockPaymentUrl: string;
  /** Phase 10b — signed ticket artifacts. */
  ticketsBucket: s3.IBucket;
  ticketSigningKey: kms.IKey;
}

/**
 * Purchase saga: step Lambdas, Step Functions definition (happy path +
 * compensation), and saga-starter (SQS → StartExecution).
 *
 * Owns step/starter grants. Exposes the state machine, starter, and step
 * functions for stack outputs / diagnostics.
 */
export class PurchaseSaga extends Construct {
  readonly purchaseSaga: sfn.StateMachine;
  readonly sagaStarterFn: lambda.IFunction;
  readonly mockPaymentUrl: string;

  readonly verifyHoldFn: lambda.IFunction;
  readonly authorizePaymentFn: lambda.IFunction;
  readonly confirmSeatFn: lambda.IFunction;
  readonly capturePaymentFn: lambda.IFunction;
  readonly issueTicketFn: lambda.IFunction;
  readonly markConfirmedFn: lambda.IFunction;
  readonly releaseSeatFn: lambda.IFunction;
  readonly markFailedFn: lambda.IFunction;
  readonly voidAuthorizationFn: lambda.IFunction;
  readonly refundPaymentFn: lambda.IFunction;
  readonly markRefundedFn: lambda.IFunction;

  constructor(scope: Construct, id: string, props: PurchaseSagaProps) {
    super(scope, id);

    const {
      stage,
      eventsTable,
      seatsTable,
      ordersTable,
      ledgerTable,
      orderQueue,
      mockPaymentSecret,
      ticketsBucket,
      ticketSigningKey,
    } = props;

    const lambdaEnv = baseLambdaEnv(stage, {
      eventsTableName: eventsTable.tableName,
      seatsTableName: seatsTable.tableName,
    });

    this.mockPaymentUrl = props.mockPaymentUrl;
    const paymentSecretEnv = {
      MOCK_PAYMENT_SECRET_ARN: mockPaymentSecret.secretArn,
    };

    // Phase 6 happy path:
    // VerifyHold → AuthorizePayment → ConfirmSeat → CapturePayment
    // → IssueTicket → MarkConfirmed → Succeed
    // AuthorizePayment Catch → ReleaseSeat → MarkFailed → SagaCompensated
    // ConfirmSeat / CapturePayment Catch → VoidAuthorization → (same) ReleaseSeat → …
    // IssueTicket / MarkConfirmed Catch → RefundPayment → ReleaseSeat → MarkRefunded
    // (Slice 3 LockSeat assert still pending).
    this.verifyHoldFn = createNodeFn(this, "VerifyHoldFn", {
      stage,
      name: "verify-hold",
      entry: path.join(projectRoot, "services/saga-steps/src/verify-hold.ts"),
      environment: {
        ...lambdaEnv,
        ORDERS_TABLE_NAME: ordersTable.tableName,
      },
    });

    this.authorizePaymentFn = createNodeFn(this, "AuthorizePaymentFn", {
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
        ...paymentSecretEnv,
        ORDER_AMOUNT_CENTS: process.env.ORDER_AMOUNT_CENTS || String(5000),
      },
    });

    const verifyHoldTask = createSagaTask(
      this,
      "VerifyHold",
      this.verifyHoldFn,
    );

    this.confirmSeatFn = createNodeFn(this, "ConfirmSeatFn", {
      stage,
      name: "confirm-seat",
      entry: path.join(projectRoot, "services/saga-steps/src/confirm-seat.ts"),
      environment: lambdaEnv,
    });

    this.capturePaymentFn = createNodeFn(this, "CapturePaymentFn", {
      stage,
      name: "capture-payment",
      entry: path.join(projectRoot, "services/saga-steps/src/capture-payment.ts"),
      timeout: cdk.Duration.seconds(15),
      environment: {
        ...lambdaEnv,
        LEDGER_TABLE_NAME: ledgerTable.tableName,
        ...paymentSecretEnv,
      },
    });

    const authorizePaymentTask = createSagaTask(
      this,
      "AuthorizePayment",
      this.authorizePaymentFn,
    );

    this.releaseSeatFn = createNodeFn(this, "ReleaseSeatFn", {
      stage,
      name: "release-seat",
      entry: path.join(projectRoot, "services/saga-steps/src/release-seat.ts"),
      environment: lambdaEnv,
    });

    this.markFailedFn = createNodeFn(this, "MarkFailedFn", {
      stage,
      name: "mark-failed",
      entry: path.join(projectRoot, "services/saga-steps/src/mark-failed.ts"),
      environment: {
        ...lambdaEnv,
        ORDERS_TABLE_NAME: ordersTable.tableName,
      },
    });

    const releaseSeatTask = createSagaTask(
      this,
      "ReleaseSeat",
      this.releaseSeatFn,
    );
    const markFailedTask = createSagaTask(
      this,
      "MarkFailed",
      this.markFailedFn,
    );

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

    this.voidAuthorizationFn = createNodeFn(this, "VoidAuthorizationFn", {
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
        ...paymentSecretEnv,
      },
    });

    const voidAuthorizationTask = createSagaTask(
      this,
      "VoidAuthorization",
      this.voidAuthorizationFn,
    );

    // Auth succeeded but ConfirmSeat or Capture failed → void first, then same tail.
    // Capture never took money; seats may be PAYING (confirm fail) or SOLD (capture fail).
    const voidThenRelease = voidAuthorizationTask.next(releaseSeatTask);

    const confirmSeatTask = createSagaTask(
      this,
      "ConfirmSeat",
      this.confirmSeatFn,
    );
    confirmSeatTask.addCatch(voidThenRelease, {
      errors: ["States.ALL"],
      resultPath: "$.error",
    });

    const capturePaymentTask = createSagaTask(
      this,
      "CapturePayment",
      this.capturePaymentFn,
    );
    capturePaymentTask.addCatch(voidThenRelease, {
      errors: ["States.ALL"],
      resultPath: "$.error",
    });

    this.issueTicketFn = createNodeFn(this, "IssueTicketFn", {
      stage,
      name: "issue-ticket",
      entry: path.join(projectRoot, "services/saga-steps/src/issue-ticket.ts"),
      timeout: cdk.Duration.seconds(30),
      environment: {
        ...lambdaEnv,
        ORDERS_TABLE_NAME: ordersTable.tableName,
        TICKETS_BUCKET: ticketsBucket.bucketName,
        TICKET_SIGNING_KEY_ID: ticketSigningKey.keyId,
      },
    });

    this.markConfirmedFn = createNodeFn(this, "MarkConfirmedFn", {
      stage,
      name: "mark-confirmed",
      entry: path.join(projectRoot, "services/saga-steps/src/mark-confirmed.ts"),
      environment: {
        ...lambdaEnv,
        ORDERS_TABLE_NAME: ordersTable.tableName,
      },
    });

    this.refundPaymentFn = createNodeFn(this, "RefundPaymentFn", {
      stage,
      name: "refund-payment",
      entry: path.join(projectRoot, "services/saga-steps/src/refund-payment.ts"),
      timeout: cdk.Duration.seconds(15),
      environment: {
        ...lambdaEnv,
        LEDGER_TABLE_NAME: ledgerTable.tableName,
        ...paymentSecretEnv,
      },
    });

    this.markRefundedFn = createNodeFn(this, "MarkRefundedFn", {
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
      this.refundPaymentFn,
    );

    // Separate ReleaseSeat state: void path ends at MarkFailed; refund ends at MarkRefunded.
    const releaseSeatAfterRefundTask = createSagaTask(
      this,
      "ReleaseSeatAfterRefund",
      this.releaseSeatFn,
    );

    const markRefundedTask = createSagaTask(
      this,
      "MarkRefunded",
      this.markRefundedFn,
    );

    // Capture succeeded but IssueTicket / MarkConfirmed failed → refund money, free seats.
    const refundThenRelease = refundPaymentTask
      .next(releaseSeatAfterRefundTask)
      .next(markRefundedTask)
      .next(sagaCompensated);

    const issueTicketTask = createSagaTask(
      this,
      "IssueTicket",
      this.issueTicketFn,
    );
    issueTicketTask.addCatch(refundThenRelease, {
      errors: ["States.ALL"],
      resultPath: "$.error",
    });

    const markConfirmedTask = createSagaTask(
      this,
      "MarkConfirmed",
      this.markConfirmedFn,
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

    this.purchaseSaga = new sfn.StateMachine(this, "StateMachine", {
      stateMachineName: `gatehold-${stage}-purchase-saga`,
      definitionBody: sfn.DefinitionBody.fromChainable(sagaDefinition),
      tracingEnabled: false,
    });

    this.sagaStarterFn = createNodeFn(this, "SagaStarterFn", {
      stage,
      name: "saga-starter",
      entry: path.join(projectRoot, "services/saga-starter/src/handler.ts"),
      timeout: cdk.Duration.seconds(30),
      environment: {
        ...lambdaEnv,
        ORDERS_TABLE_NAME: ordersTable.tableName,
        PURCHASE_SAGA_ARN: this.purchaseSaga.stateMachineArn,
      },
    });
    this.sagaStarterFn.addEventSource(
      new SqsEventSource(orderQueue, {
        batchSize: 5,
        reportBatchItemFailures: true,
      }),
    );

    // saga-starter: UpdateItem executionArn only (no table reads).
    ordersTable.grantWriteData(this.sagaStarterFn);
    this.purchaseSaga.grantStartExecution(this.sagaStarterFn);

    eventsTable.grantReadData(this.verifyHoldFn);
    seatsTable.grantReadData(this.verifyHoldFn);
    ordersTable.grantReadData(this.verifyHoldFn);

    // authorize: ledger Put + orders Update. capture/void/refund: ledger Put only.
    ledgerTable.grantWriteData(this.authorizePaymentFn);
    ordersTable.grantWriteData(this.authorizePaymentFn);

    grantTableWriteWithTransact(seatsTable, this.confirmSeatFn);
    grantTableWriteWithTransact(seatsTable, this.releaseSeatFn);

    ledgerTable.grantWriteData(this.capturePaymentFn);
    ledgerTable.grantWriteData(this.voidAuthorizationFn);
    ledgerTable.grantWriteData(this.refundPaymentFn);

    ordersTable.grantWriteData(this.issueTicketFn);
    ordersTable.grantWriteData(this.markConfirmedFn);
    ordersTable.grantWriteData(this.markFailedFn);
    ordersTable.grantWriteData(this.markRefundedFn);

    // Phase 10b — sign + store ticket artifacts (private key never leaves KMS).
    ticketsBucket.grantPut(this.issueTicketFn);
    ticketSigningKey.grant(this.issueTicketFn, "kms:Sign");

    // Payment provider URL — only these four may read the secret (9d.2).
    mockPaymentSecret.grantRead(this.authorizePaymentFn);
    mockPaymentSecret.grantRead(this.capturePaymentFn);
    mockPaymentSecret.grantRead(this.voidAuthorizationFn);
    mockPaymentSecret.grantRead(this.refundPaymentFn);
  }
}
