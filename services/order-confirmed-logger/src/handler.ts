import type { EventBridgeEvent } from "aws-lambda";

/** Phase 8b — EventBridge OrderConfirmed detail (docs/contracts.md). */
export interface OrderConfirmedDetail {
  orderId: string;
  eventId: string;
  userId: string;
  seatIds: string[];
  confirmedAt: string;
}

/**
 * Temporary bus inspect target (MiniStack does not reliably deliver
 * EventBridge → CloudWatch Logs). Logs the matched event for local verify.
 */
export async function handler(
  event: EventBridgeEvent<"OrderConfirmed", OrderConfirmedDetail>,
): Promise<void> {
  console.log(
    "OrderConfirmed received",
    JSON.stringify({
      id: event.id,
      source: event.source,
      "detail-type": event["detail-type"],
      detail: event.detail,
    }),
  );
}
