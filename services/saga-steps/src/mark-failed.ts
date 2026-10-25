import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  buildMarkFailedUpdateInput,
  getDocClient,
  requireEnv,
} from "../../shared/src";
import type { CompensatingSagaState } from "./release-seat";

const FAIL_REASON_MAX_LEN = 500;

/**
 * Business failure — order not PENDING/FAILED (or missing).
 */
export class MarkFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkFailedError";
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
 * Phase 6 compensation — MarkFailed.
 * Order PENDING → FAILED (idempotent if already FAILED).
 * Optional failReason from Catch `$.error`.
 */
export async function handler(
  event: CompensatingSagaState,
): Promise<CompensatingSagaState> {
  const ordersTable = requireEnv("ORDERS_TABLE_NAME");

  if (!event.orderId) {
    throw new MarkFailedError("orderId required");
  }

  const failReason = failReasonFromCatch(event.error);

  try {
    await getDocClient().send(
      new UpdateCommand(
        buildMarkFailedUpdateInput({
          tableName: ordersTable,
          orderId: event.orderId,
          failReason,
        }),
      ),
    );
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      throw new MarkFailedError(
        `mark failed failed for order ${event.orderId}: not PENDING/FAILED`,
      );
    }
    if (isTransientDynamoError(err)) {
      throw new TransientError(
        err instanceof Error ? err.message : String(err),
      );
    }
    throw err;
  }

  console.info("mark-failed ok", {
    orderId: event.orderId,
    failReason,
  });

  return event;
}

function failReasonFromCatch(
  error: CompensatingSagaState["error"],
): string | undefined {
  if (!error) return undefined;
  const parts = [error.Error, error.Cause].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  if (parts.length === 0) return undefined;
  const joined = parts.join(": ");
  return joined.length > FAIL_REASON_MAX_LEN
    ? joined.slice(0, FAIL_REASON_MAX_LEN)
    : joined;
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
