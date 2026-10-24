import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  buildMarkConfirmedUpdateInput,
  getDocClient,
  requireEnv,
} from "../../shared/src";
import type { TicketedSagaState } from "../../shared/src/types";

/**
 * Business failure — order not PENDING/CONFIRMED (or missing).
 */
export class MarkConfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkConfirmedError";
  }
}

/**
 * Transient DynamoDB failure — safe for Step Functions retry.
 */
export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientError";
  }
}

/**
 * Phase 6 Slice 7 — MarkConfirmed.
 * Order PENDING → CONFIRMED (idempotent if already CONFIRMED).
 * Happy-path terminal business write before Succeed.
 */
export async function handler(
  event: TicketedSagaState,
): Promise<TicketedSagaState> {
  const ordersTable = requireEnv("ORDERS_TABLE_NAME");

  if (!event.ticketIds?.length) {
    throw new MarkConfirmedError(
      "ticketIds required (run IssueTicket first)",
    );
  }

  try {
    await getDocClient().send(
      new UpdateCommand(
        buildMarkConfirmedUpdateInput({
          tableName: ordersTable,
          orderId: event.orderId,
        }),
      ),
    );
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      throw new MarkConfirmedError(
        `mark confirmed failed for order ${event.orderId}: not PENDING/CONFIRMED`,
      );
    }
    if (isTransientDynamoError(err)) {
      throw new TransientError(
        err instanceof Error ? err.message : String(err),
      );
    }
    throw err;
  }

  console.info("mark-confirmed ok", {
    orderId: event.orderId,
    ticketIds: event.ticketIds,
  });

  return event;
}

function isConditionalCheckFailed(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { name?: string }).name === "ConditionalCheckFailedException";
}

function isTransientDynamoError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return (
    name === "ProvisionedThroughputExceededException" ||
    name === "ThrottlingException" ||
    name === "RequestLimitExceeded" ||
    name === "InternalServerError" ||
    name === "ServiceUnavailable"
  );
}
