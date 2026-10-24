import {
  ExecutionAlreadyExists,
  StartExecutionCommand,
} from "@aws-sdk/client-sfn";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSEvent, SQSBatchResponse, SQSRecord } from "aws-lambda";
import { getDocClient, requireEnv } from "../../shared/src";
import { getSfnClient } from "../../shared/src/sfn";
import type { OrderQueueMessage } from "../../shared/src/types";

/**
 * Phase 6 — drain order SQS and start the purchase saga.
 * Execution name = orderId so duplicate deliveries do not start a second run.
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const stateMachineArn = requireEnv("PURCHASE_SAGA_ARN");
  const ordersTable = requireEnv("ORDERS_TABLE_NAME");

  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];

  for (const record of event.Records) {
    try {
      await processRecord(record, stateMachineArn, ordersTable);
    } catch (err) {
      console.error("saga-starter failed", {
        messageId: record.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}

async function processRecord(
  record: SQSRecord,
  stateMachineArn: string,
  ordersTable: string,
): Promise<void> {
  const message = parseOrderMessage(record.body);
  const input = JSON.stringify(message);

  let executionArn: string;
  try {
    const started = await getSfnClient().send(
      new StartExecutionCommand({
        stateMachineArn,
        name: message.orderId,
        input,
      }),
    );
    if (!started.executionArn) {
      throw new Error("StartExecution returned no executionArn");
    }
    executionArn = started.executionArn;
  } catch (err) {
    if (isExecutionAlreadyExists(err)) {
      // Same orderId already started (or closed within the 90-day name window).
      // Ack the SQS message — do not retry into a loop.
      console.info("saga already exists", { orderId: message.orderId });
      return;
    }
    throw err;
  }

  await attachExecutionArn(ordersTable, message.orderId, executionArn);
}

function parseOrderMessage(body: string): OrderQueueMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("order queue body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("order queue body must be an object");
  }
  const msg = parsed as Partial<OrderQueueMessage>;
  if (
    typeof msg.orderId !== "string" ||
    !msg.orderId ||
    typeof msg.eventId !== "string" ||
    typeof msg.holdId !== "string" ||
    typeof msg.userId !== "string" ||
    !Array.isArray(msg.seatIds) ||
    msg.seatIds.length === 0 ||
    !msg.seatIds.every((s) => typeof s === "string" && s.length > 0)
  ) {
    throw new Error("order queue body missing required OrderQueueMessage fields");
  }
  return {
    orderId: msg.orderId,
    eventId: msg.eventId,
    holdId: msg.holdId,
    seatIds: msg.seatIds,
    userId: msg.userId,
  };
}

function isExecutionAlreadyExists(err: unknown): boolean {
  if (err instanceof ExecutionAlreadyExists) return true;
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: string }).name === "ExecutionAlreadyExists"
  );
}

async function attachExecutionArn(
  ordersTable: string,
  orderId: string,
  executionArn: string,
): Promise<void> {
  try {
    await getDocClient().send(
      new UpdateCommand({
        TableName: ordersTable,
        Key: { orderId },
        UpdateExpression: "SET executionArn = :arn",
        ConditionExpression:
          "attribute_not_exists(executionArn) OR executionArn = :arn",
        ExpressionAttributeValues: { ":arn": executionArn },
      }),
    );
  } catch (err) {
    // Conditional fail means another writer set a different ARN — leave as-is.
    if (
      err &&
      typeof err === "object" &&
      "name" in err &&
      (err as { name: string }).name === "ConditionalCheckFailedException"
    ) {
      console.warn("order already has a different executionArn", { orderId });
      return;
    }
    throw err;
  }
}
