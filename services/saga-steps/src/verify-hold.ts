import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { getDocClient, requireEnv } from "../../shared/src";
import type {
  EventItem,
  OrderItem,
  SagaInput,
  SeatItem,
} from "../../shared/src/types";

/**
 * Business failure — seat/order/event checks failed.
 * Must not be retried by Step Functions (Catch will compensate later).
 */
export class VerifyHoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyHoldError";
  }
}

/**
 * Transient DynamoDB / infra failure — safe to retry.
 */
export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientError";
  }
}

/**
 * Phase 6 Slice 2 — VerifyHold.
 * Confirms order is still PENDING, event ON_SALE, and every seat is still
 * PAYING for this hold/order with payUntil in the future.
 * Does not mutate state; returns saga input unchanged on success.
 */
export async function handler(event: SagaInput): Promise<SagaInput> {
  const ordersTable = requireEnv("ORDERS_TABLE_NAME");
  const eventsTable = requireEnv("EVENTS_TABLE_NAME");
  const seatsTable = requireEnv("SEATS_TABLE_NAME");
  const nowIso = new Date().toISOString();

  try {
    await verifyHold(event, {
      ordersTable,
      eventsTable,
      seatsTable,
      nowIso,
    });
  } catch (err) {
    if (err instanceof VerifyHoldError || err instanceof TransientError) {
      console.error("verify-hold failed", {
        orderId: event.orderId,
        error: err.name,
        message: err.message,
      });
      throw err;
    }
    if (isTransientDynamoError(err)) {
      throw new TransientError(
        err instanceof Error ? err.message : String(err),
      );
    }
    throw err;
  }

  console.info("verify-hold ok", {
    orderId: event.orderId,
    eventId: event.eventId,
    holdId: event.holdId,
    seatIds: event.seatIds,
  });
  return event;
}

export async function verifyHold(
  input: SagaInput,
  opts: {
    ordersTable: string;
    eventsTable: string;
    seatsTable: string;
    nowIso: string;
  },
): Promise<void> {
  const order = await getOrder(opts.ordersTable, input.orderId);
  if (!order) {
    throw new VerifyHoldError(`order not found: ${input.orderId}`);
  }
  if (order.status !== "PENDING") {
    throw new VerifyHoldError(
      `order ${input.orderId} status is ${order.status}, expected PENDING`,
    );
  }
  if (order.eventId !== input.eventId) {
    throw new VerifyHoldError(
      `order ${input.orderId} eventId mismatch (order=${order.eventId}, input=${input.eventId})`,
    );
  }
  if (order.holdId !== input.holdId) {
    throw new VerifyHoldError(
      `order ${input.orderId} holdId mismatch (order=${order.holdId}, input=${input.holdId})`,
    );
  }
  if (!sameSeatIds(order.seatIds, input.seatIds)) {
    throw new VerifyHoldError(
      `order ${input.orderId} seatIds mismatch`,
    );
  }

  const eventItem = await getEvent(opts.eventsTable, input.eventId);
  if (!eventItem) {
    throw new VerifyHoldError(`event not found: ${input.eventId}`);
  }
  if (eventItem.status !== "ON_SALE") {
    throw new VerifyHoldError(
      `event ${input.eventId} status is ${eventItem.status}, expected ON_SALE`,
    );
  }

  const seats = await Promise.all(
    input.seatIds.map((seatId) =>
      getSeat(opts.seatsTable, input.eventId, seatId),
    ),
  );

  for (let i = 0; i < input.seatIds.length; i++) {
    const seatId = input.seatIds[i];
    const seat = seats[i];
    if (!seat) {
      throw new VerifyHoldError(
        `seat not found: ${input.eventId}/${seatId}`,
      );
    }
    if (seat.status !== "PAYING") {
      throw new VerifyHoldError(
        `seat ${seatId} status is ${seat.status}, expected PAYING`,
      );
    }
    if (seat.holdId !== input.holdId) {
      throw new VerifyHoldError(
        `seat ${seatId} holdId mismatch (seat=${seat.holdId}, input=${input.holdId})`,
      );
    }
    if (seat.orderId !== input.orderId) {
      throw new VerifyHoldError(
        `seat ${seatId} orderId mismatch (seat=${seat.orderId}, input=${input.orderId})`,
      );
    }
    if (!seat.payUntil || seat.payUntil <= opts.nowIso) {
      throw new VerifyHoldError(
        `seat ${seatId} payUntil expired or missing (payUntil=${seat.payUntil ?? "none"}, now=${opts.nowIso})`,
      );
    }
  }
}

async function getOrder(
  tableName: string,
  orderId: string,
): Promise<OrderItem | undefined> {
  const result = await getDocClient().send(
    new GetCommand({
      TableName: tableName,
      Key: { orderId },
    }),
  );
  return result.Item as OrderItem | undefined;
}

async function getEvent(
  tableName: string,
  eventId: string,
): Promise<EventItem | undefined> {
  const result = await getDocClient().send(
    new GetCommand({
      TableName: tableName,
      Key: { eventId },
    }),
  );
  return result.Item as EventItem | undefined;
}

async function getSeat(
  tableName: string,
  eventId: string,
  seatId: string,
): Promise<SeatItem | undefined> {
  const result = await getDocClient().send(
    new GetCommand({
      TableName: tableName,
      Key: { eventId, seatId },
    }),
  );
  return result.Item as SeatItem | undefined;
}

function sameSeatIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((id, i) => id === sortedB[i]);
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
