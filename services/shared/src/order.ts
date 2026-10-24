/** Create-order helpers — keep expressions in sync with docs/contracts.md */

/** How long seats stay PAYING after accept (protects inventory while order is PENDING). */
export const PAY_WINDOW_MS = 15 * 60 * 1000;

/** Default TTL for idempotency records (7 days), as epoch-second offset from now. */
export const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface LockSeatForPaymentParams {
  tableName: string;
  eventId: string;
  seatId: string;
  holdId: string;
  holdOwner: string;
  orderId: string;
  /** ISO-8601 written to payUntil */
  payUntil: string;
  /** ISO-8601 "now" — seat must still be HELD with expiresAt > now */
  now: string;
}

export interface CreateOrderTransactParams {
  seatsTableName: string;
  eventsTableName: string;
  ordersTableName: string;
  idempotencyTableName: string;
  idempotencyKey: string;
  orderId: string;
  userId: string;
  eventId: string;
  holdId: string;
  seatIds: string[];
  /** ISO-8601 — used in seat conditions and order createdAt */
  now: string;
  /** ISO-8601 — seat payUntil */
  payUntil: string;
  /** Epoch seconds — idempotency item TTL */
  ttl: number;
}

/**
 * Builds Update input for HELD → PAYING under a specific hold.
 * Pure: no I/O — safe to unit-test the condition/SET expressions.
 */
export function buildLockSeatForPaymentUpdateInput(
  params: LockSeatForPaymentParams,
) {
  const {
    tableName,
    eventId,
    seatId,
    holdId,
    holdOwner,
    orderId,
    payUntil,
    now,
  } = params;

  return {
    TableName: tableName,
    Key: { eventId, seatId },
    UpdateExpression:
      "SET #status = :paying, orderId = :orderId, payUntil = :payUntil",
    ConditionExpression:
      "holdId = :holdId AND holdOwner = :holdOwner AND #status = :held AND expiresAt > :now",
    ExpressionAttributeNames: {
      "#status": "status",
    },
    ExpressionAttributeValues: {
      ":paying": "PAYING",
      ":held": "HELD",
      ":holdId": holdId,
      ":holdOwner": holdOwner,
      ":orderId": orderId,
      ":payUntil": payUntil,
      ":now": now,
    },
  };
}

/**
 * Builds TransactWriteCommand input for create-order accept:
 * claim idempotency + event ON_SALE + seats PAYING + order PENDING.
 * Pure — handler only does `new TransactWriteCommand(buildCreateOrderTransactWriteInput(...))`.
 */
export function buildCreateOrderTransactWriteInput(
  params: CreateOrderTransactParams,
) {
  const {
    seatsTableName,
    eventsTableName,
    ordersTableName,
    idempotencyTableName,
    idempotencyKey,
    orderId,
    userId,
    eventId,
    holdId,
    seatIds,
    now,
    payUntil,
    ttl,
  } = params;

  const seatUpdates = seatIds.map((seatId) => ({
    Update: buildLockSeatForPaymentUpdateInput({
      tableName: seatsTableName,
      eventId,
      seatId,
      holdId,
      holdOwner: userId,
      orderId,
      payUntil,
      now,
    }),
  }));

  return {
    TransactItems: [
      {
        Put: {
          TableName: idempotencyTableName,
          Item: {
            key: idempotencyKey,
            status: "IN_PROGRESS",
            orderId,
            ttl,
          },
          ConditionExpression: "attribute_not_exists(#k)",
          ExpressionAttributeNames: {
            "#k": "key",
          },
        },
      },
      {
        ConditionCheck: {
          TableName: eventsTableName,
          Key: { eventId },
          ConditionExpression: "#status = :onSale",
          ExpressionAttributeNames: {
            "#status": "status",
          },
          ExpressionAttributeValues: {
            ":onSale": "ON_SALE",
          },
        },
      },
      ...seatUpdates,
      {
        Put: {
          TableName: ordersTableName,
          Item: {
            orderId,
            userId,
            eventId,
            holdId,
            seatIds,
            status: "PENDING",
            idempotencyKey,
            createdAt: now,
          },
          ConditionExpression: "attribute_not_exists(orderId)",
        },
      },
    ],
  };
}

export interface ConfirmSeatUpdateParams {
  tableName: string;
  eventId: string;
  seatId: string;
  holdId: string;
  orderId: string;
}

export interface ConfirmSeatsTransactParams {
  seatsTableName: string;
  eventId: string;
  holdId: string;
  orderId: string;
  seatIds: string[];
}

/**
 * Builds Update input for PAYING → SOLD under a specific hold/order.
 * Idempotent: already SOLD for the same holdId+orderId also succeeds.
 */
export function buildConfirmSeatUpdateInput(params: ConfirmSeatUpdateParams) {
  const { tableName, eventId, seatId, holdId, orderId } = params;

  return {
    TableName: tableName,
    Key: { eventId, seatId },
    UpdateExpression: "SET #status = :sold",
    ConditionExpression:
      "holdId = :holdId AND orderId = :orderId AND (#status = :paying OR #status = :sold)",
    ExpressionAttributeNames: {
      "#status": "status",
    },
    ExpressionAttributeValues: {
      ":sold": "SOLD",
      ":paying": "PAYING",
      ":holdId": holdId,
      ":orderId": orderId,
    },
  };
}

/**
 * All seats PAYING→SOLD in one TransactWrite (all-or-nothing).
 */
export function buildConfirmSeatsTransactWriteInput(
  params: ConfirmSeatsTransactParams,
) {
  const { seatsTableName, eventId, holdId, orderId, seatIds } = params;

  return {
    TransactItems: seatIds.map((seatId) => ({
      Update: buildConfirmSeatUpdateInput({
        tableName: seatsTableName,
        eventId,
        seatId,
        holdId,
        orderId,
      }),
    })),
  };
}

export interface IssueTicketsUpdateParams {
  tableName: string;
  orderId: string;
  ticketIds: string[];
}

export interface MarkConfirmedUpdateParams {
  tableName: string;
  orderId: string;
  /** Optional — only set when missing (starter usually already wrote it). */
  executionArn?: string;
}

/**
 * Writes placeholder ticketIds on the order once (idempotent retries).
 */
export function buildIssueTicketsUpdateInput(params: IssueTicketsUpdateParams) {
  const { tableName, orderId, ticketIds } = params;
  return {
    TableName: tableName,
    Key: { orderId },
    UpdateExpression: "SET ticketIds = if_not_exists(ticketIds, :ticketIds)",
    ConditionExpression: "attribute_exists(orderId)",
    ExpressionAttributeValues: {
      ":ticketIds": ticketIds,
    },
  };
}

/**
 * PENDING → CONFIRMED. Idempotent if already CONFIRMED.
 * Optionally fills executionArn when still missing.
 */
export function buildMarkConfirmedUpdateInput(params: MarkConfirmedUpdateParams) {
  const { tableName, orderId, executionArn } = params;

  const expressionNames = { "#status": "status" };
  const expressionValues: Record<string, string> = {
    ":confirmed": "CONFIRMED",
    ":pending": "PENDING",
  };

  let updateExpression = "SET #status = :confirmed";
  if (executionArn) {
    updateExpression +=
      ", executionArn = if_not_exists(executionArn, :executionArn)";
    expressionValues[":executionArn"] = executionArn;
  }

  return {
    TableName: tableName,
    Key: { orderId },
    UpdateExpression: updateExpression,
    ConditionExpression:
      "attribute_exists(orderId) AND (#status = :pending OR #status = :confirmed)",
    ExpressionAttributeNames: expressionNames,
    ExpressionAttributeValues: expressionValues,
  };
}

/** Compute payUntil ISO string from a reference time (defaults to Date.now()). */
export function payUntilAt(
  nowMs: number = Date.now(),
  durationMs: number = PAY_WINDOW_MS,
): string {
  return new Date(nowMs + durationMs).toISOString();
}

/** Epoch-second TTL for an idempotency record starting at nowMs. */
export function idempotencyTtlEpoch(
  nowMs: number = Date.now(),
  ttlSeconds: number = IDEMPOTENCY_TTL_SECONDS,
): number {
  return Math.floor(nowMs / 1000) + ttlSeconds;
}
