import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  buildIssueTicketsUpdateInput,
  getDocClient,
  placeholderTicketIds,
  requireEnv,
} from "../../shared/src";
import type {
  AuthorizedSagaState,
  TicketedSagaState,
} from "../../shared/src/types";

/**
 * Business failure — order missing or could not record placeholder tickets.
 */
export class IssueTicketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssueTicketError";
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
 * Phase 6 Slice 7 — IssueTicket (stub).
 * Writes deterministic placeholder ticketIds on the order (no KMS/S3 yet).
 * Phase 9 replaces this with signed artifacts in S3.
 */
export async function handler(
  event: AuthorizedSagaState,
): Promise<TicketedSagaState> {
  const ordersTable = requireEnv("ORDERS_TABLE_NAME");

  if (!event.seatIds?.length) {
    throw new IssueTicketError("seatIds required");
  }

  const ticketIds = placeholderTicketIds(event.orderId, event.seatIds);

  try {
    await getDocClient().send(
      new UpdateCommand(
        buildIssueTicketsUpdateInput({
          tableName: ordersTable,
          orderId: event.orderId,
          ticketIds,
        }),
      ),
    );
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      throw new IssueTicketError(
        `issue ticket failed for order ${event.orderId}: order not found`,
      );
    }
    if (isTransientDynamoError(err)) {
      throw new TransientError(
        err instanceof Error ? err.message : String(err),
      );
    }
    throw err;
  }

  console.info("issue-ticket ok (stub)", {
    orderId: event.orderId,
    ticketIds,
  });

  return {
    ...event,
    ticketIds,
  };
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
