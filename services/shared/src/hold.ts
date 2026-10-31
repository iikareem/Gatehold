/** Hold helpers — keep expressions in sync with docs/contracts.md */

/** Hold length for Phase 1 (matches README: now + 5 minutes). */
export const HOLD_DURATION_MS = 5 * 60 * 1000;

export interface HoldSeatUpdateParams {
  tableName: string;
  eventId: string;
  seatId: string;
  holdId: string;
  holdOwner: string;
  /** ISO-8601 expiry written to the item */
  expiresAt: string;
  /** ISO-8601 "now" used in the condition (reclaim if expiresAt < now) */
  now: string;
}

export interface HoldSeatsTransactParams {
  tableName: string;
  /** Events table — ConditionCheck status = ON_SALE (Phase 11b). */
  eventsTableName: string;
  eventId: string;
  seatIds: string[];
  holdId: string;
  holdOwner: string;
  expiresAt: string;
  now: string;
}

/**
 * Builds UpdateCommand input for AVAILABLE → HELD (or expired HELD reclaim).
 * Pure: no I/O — safe to unit-test the condition/SET expressions.
 * Phase 1 does not touch `version` (optional until check-then-act paths need it).
 */
export function buildHoldSeatUpdateInput(params: HoldSeatUpdateParams) {
  const { tableName, eventId, seatId, holdId, holdOwner, expiresAt, now } =
    params;

  return {
    TableName: tableName,
    Key: { eventId, seatId },
    UpdateExpression:
      "SET #status = :held, holdId = :holdId, holdOwner = :holdOwner, expiresAt = :expiresAt",
    ConditionExpression:
      "#status = :available OR (#status = :held AND expiresAt < :now)",
    ExpressionAttributeNames: {
      "#status": "status",
    },
    ExpressionAttributeValues: {
      ":held": "HELD",
      ":available": "AVAILABLE",
      ":holdId": holdId,
      ":holdOwner": holdOwner,
      ":expiresAt": expiresAt,
      ":now": now,
    },
  };
}

/**
 * Builds TransactWriteCommand input: event ON_SALE check + one Update per seat.
 * Pure — handler only does `new TransactWriteCommand(buildHoldSeatsTransactWriteInput(...))`.
 */
export function buildHoldSeatsTransactWriteInput(
  params: HoldSeatsTransactParams,
) {
  const {
    tableName,
    eventsTableName,
    eventId,
    seatIds,
    holdId,
    holdOwner,
    expiresAt,
    now,
  } = params;

  return {
    TransactItems: [
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
      ...seatIds.map((seatId) => ({
        Update: buildHoldSeatUpdateInput({
          tableName,
          eventId,
          seatId,
          holdId,
          holdOwner,
          expiresAt,
          now,
        }),
      })),
    ],
  };
}

/** Compute expiresAt ISO string from a reference time (defaults to Date.now()). */
export function holdExpiresAt(
  nowMs: number = Date.now(),
  durationMs: number = HOLD_DURATION_MS,
): string {
  return new Date(nowMs + durationMs).toISOString();
}
