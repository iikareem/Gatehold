export type {
  SeatStatus,
  OrderStatus,
  EventStatus,
  EventItem,
  SeatItem,
} from "./types";

export { requireEnv, optionalEnv } from "./env";
export { createDynamoDBClient, getDocClient } from "./dynamodb";
export {
  HOLD_DURATION_MS,
  buildHoldSeatUpdateInput,
  buildHoldSeatsTransactWriteInput,
  holdExpiresAt,
  type HoldSeatUpdateParams,
  type HoldSeatsTransactParams,
} from "./hold";

/** Zero-pad a seat number so row range queries sort correctly (e.g. 7 → "07"). */
export function formatSeatId(
  section: string,
  row: string | number,
  seatNum: number,
  width = 2,
): string {
  return `${section}-${row}-${String(seatNum).padStart(width, "0")}`;
}
