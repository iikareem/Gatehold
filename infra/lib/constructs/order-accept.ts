import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { grantTableWriteWithTransact } from "../helpers/iam-grants";
import {
  baseLambdaEnv,
  createNodeFn,
  projectRoot,
} from "../helpers/node-fn";

export interface OrderAcceptProps {
  stage: string;
  removalPolicy: cdk.RemovalPolicy;
  eventsTable: dynamodb.ITable;
  seatsTable: dynamodb.ITable;
  ordersTable: dynamodb.ITable;
  idempotencyTable: dynamodb.ITable;
  /** Max seats per order SSM param (Phase 9d.3; same as holds). */
  maxHoldSeatsParam: ssm.IStringParameter;
}

/**
 * Order accept path: DLQ + orders SQS queue + create-order Lambda.
 *
 * Creates the single order pipe and grants create-order what it needs
 * (events/seats/orders/idempotency + send on the queue). Exposes the
 * queue for saga-starter (and createOrderFn for the HTTP API).
 */
export class OrderAccept extends Construct {
  readonly orderDlq: sqs.Queue;
  readonly orderQueue: sqs.Queue;
  readonly createOrderFn: lambda.IFunction;

  constructor(scope: Construct, id: string, props: OrderAcceptProps) {
    super(scope, id);

    const {
      stage,
      removalPolicy,
      eventsTable,
      seatsTable,
      ordersTable,
      idempotencyTable,
      maxHoldSeatsParam,
    } = props;

    this.orderDlq = new sqs.Queue(this, "OrderDlq", {
      queueName: `gatehold-${stage}-orders-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy,
    });

    this.orderQueue = new sqs.Queue(this, "OrderQueue", {
      queueName: `gatehold-${stage}-orders`,
      // Must exceed saga-starter timeout (SFN start + order update).
      visibilityTimeout: cdk.Duration.seconds(90),
      retentionPeriod: cdk.Duration.days(4),
      removalPolicy,
      deadLetterQueue: {
        queue: this.orderDlq,
        maxReceiveCount: 5,
      },
    });

    const lambdaEnv = baseLambdaEnv(stage, {
      eventsTableName: eventsTable.tableName,
      seatsTableName: seatsTable.tableName,
    });

    this.createOrderFn = createNodeFn(this, "CreateOrderFn", {
      stage,
      name: "create-order",
      entry: path.join(projectRoot, "services/create-order/src/handler.ts"),
      environment: {
        ...lambdaEnv,
        ORDERS_TABLE_NAME: ordersTable.tableName,
        IDEMPOTENCY_TABLE_NAME: idempotencyTable.tableName,
        ORDER_QUEUE_URL: this.orderQueue.queueUrl,
        MAX_HOLD_SEATS_PARAM_NAME: maxHoldSeatsParam.parameterName,
      },
    });

    // events: ConditionCheck (read). seats/orders: Transact Put/Update (write).
    // idempotency: Put + Get + Update on conflict path (read+write).
    eventsTable.grantReadData(this.createOrderFn);
    grantTableWriteWithTransact(seatsTable, this.createOrderFn);
    grantTableWriteWithTransact(ordersTable, this.createOrderFn);
    idempotencyTable.grantReadWriteData(this.createOrderFn);
    this.orderQueue.grantSendMessages(this.createOrderFn);
    maxHoldSeatsParam.grantRead(this.createOrderFn);
  }
}
