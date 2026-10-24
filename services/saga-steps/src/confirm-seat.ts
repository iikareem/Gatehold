import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  buildConfirmSeatsTransactWriteInput,
  getDocClient,
  requireEnv,
} from "../../shared/src";
import type { AuthorizedSagaState } from "../../shared/src/types";

/**
 * Business failure — seats could not be confirmed (condition failed).
 */
export class ConfirmSeatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfirmSeatError";
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
 * Phase 6 Slice 5 — ConfirmSeat.
 * TransactWrite all order seats PAYING → SOLD (same holdId + orderId).
 * Idempotent if already SOLD for this order. Passes saga state through.
 */
export async function handler(
  event: AuthorizedSagaState,
): Promise<AuthorizedSagaState> {
  const seatsTable = requireEnv("SEATS_TABLE_NAME");

  if (!event.seatIds?.length) {
    throw new ConfirmSeatError("seatIds required");
  }
  if (!event.authorizationId) {
    throw new ConfirmSeatError("authorizationId required (run AuthorizePayment first)");
  }

  const transactInput = buildConfirmSeatsTransactWriteInput({
    seatsTableName: seatsTable,
    eventId: event.eventId,
    holdId: event.holdId,
    orderId: event.orderId,
    seatIds: event.seatIds,
  });

  try {
    await getDocClient().send(new TransactWriteCommand(transactInput));
  } catch (err) {
    if (isTransactionCanceled(err) || isConditionalCheckFailed(err)) {
      throw new ConfirmSeatError(
        `confirm seat failed for order ${event.orderId}: seats not PAYING for this hold/order`,
      );
    }
    if (isTransientDynamoError(err)) {
      throw new TransientError(
        err instanceof Error ? err.message : String(err),
      );
    }
    throw err;
  }

  console.info("confirm-seat ok", {
    orderId: event.orderId,
    seatIds: event.seatIds,
  });
  return event;
}

function isConditionalCheckFailed(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { name?: string }).name === "ConditionalCheckFailedException";
}

function isTransactionCanceled(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { name?: string }).name === "TransactionCanceledException";
}

function isTransientDynamoError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return (
    name === "ProvisionedThroughputExceededException" ||
    name === "ThrottlingException" ||
    name === "RequestLimitExceeded" ||
    name === "InternalServerError" ||
    name === "ServiceUnavailable" ||
    name === "TransactionInProgressException"
  );
}
