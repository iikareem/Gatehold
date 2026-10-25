import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  buildReleaseSeatsTransactWriteInput,
  getDocClient,
  requireEnv,
} from "../../shared/src";
import type { SagaInput } from "../../shared/src/types";

/** Saga state on compensation path (Catch may attach `error`). */
export interface CompensatingSagaState extends SagaInput {
  error?: {
    Error?: string;
    Cause?: string;
  };
}

/**
 * Business failure — seats could not be released (condition failed).
 */
export class ReleaseSeatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseSeatError";
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
 * Phase 6 compensation — ReleaseSeat.
 * TransactWrite all order seats PAYING/SOLD → AVAILABLE (same holdId + orderId).
 * Idempotent if already AVAILABLE. Passes saga state through for MarkFailed.
 */
export async function handler(
  event: CompensatingSagaState,
): Promise<CompensatingSagaState> {
  const seatsTable = requireEnv("SEATS_TABLE_NAME");

  if (!event.seatIds?.length) {
    throw new ReleaseSeatError("seatIds required");
  }

  const transactInput = buildReleaseSeatsTransactWriteInput({
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
      throw new ReleaseSeatError(
        `release seat failed for order ${event.orderId}: seats not PAYING/SOLD for this hold/order`,
      );
    }
    if (isTransientDynamoError(err)) {
      throw new TransientError(
        err instanceof Error ? err.message : String(err),
      );
    }
    throw err;
  }

  console.info("release-seat ok", {
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
