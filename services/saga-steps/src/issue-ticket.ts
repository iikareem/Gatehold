import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  buildIssueTicketsUpdateInput,
  buildTicketPayload,
  getDocClient,
  putTicketArtifact,
  requireEnv,
  signTicketMessage,
  ticketObjectKey,
  ticketSigningMessage,
} from "../../shared/src";
import type {
  AuthorizedSagaState,
  TicketedSagaState,
} from "../../shared/src/types";

/**
 * Business failure — missing input, order missing, or non-retryable issue.
 */
export class IssueTicketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssueTicketError";
  }
}

/**
 * Transient AWS failure — safe for Step Functions retry.
 */
export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientError";
  }
}

/**
 * Phase 10b — IssueTicket.
 * For each seat: build payload → KMS.Sign → PutObject `{payload,signature}` →
 * then write ticketIds on the order (idempotent if_not_exists).
 */
export async function handler(
  event: AuthorizedSagaState,
): Promise<TicketedSagaState> {
  const ordersTable = requireEnv("ORDERS_TABLE_NAME");
  const ticketsBucket = requireEnv("TICKETS_BUCKET");
  const signingKeyId = requireEnv("TICKET_SIGNING_KEY_ID");

  if (!event.seatIds?.length) {
    throw new IssueTicketError("seatIds required");
  }
  if (!event.eventId) {
    throw new IssueTicketError("eventId required");
  }
  if (!event.userId) {
    throw new IssueTicketError("userId required");
  }

  const ticketIds: string[] = [];

  try {
    for (const seatId of event.seatIds) {
      const payload = buildTicketPayload({
        orderId: event.orderId,
        eventId: event.eventId,
        seatId,
        userId: event.userId,
      });
      const signature = await signTicketMessage(
        signingKeyId,
        ticketSigningMessage(payload),
      );
      await putTicketArtifact({
        bucket: ticketsBucket,
        key: ticketObjectKey(payload.ticketId),
        artifact: { payload, signature },
      });
      ticketIds.push(payload.ticketId);
    }

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
    if (err instanceof IssueTicketError || err instanceof TransientError) {
      throw err;
    }
    if (isConditionalCheckFailed(err)) {
      throw new IssueTicketError(
        `issue ticket failed for order ${event.orderId}: order not found`,
      );
    }
    if (isTransientAwsError(err)) {
      throw new TransientError(
        err instanceof Error ? err.message : String(err),
      );
    }
    throw err;
  }

  console.info("issue-ticket ok", {
    orderId: event.orderId,
    ticketIds,
    bucket: ticketsBucket,
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

function isTransientAwsError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return (
    name === "ProvisionedThroughputExceededException" ||
    name === "ThrottlingException" ||
    name === "RequestLimitExceeded" ||
    name === "InternalServerError" ||
    name === "ServiceUnavailable" ||
    name === "SlowDown" ||
    name === "TimeoutError" ||
    name === "NetworkingError"
  );
}
