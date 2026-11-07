import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  getDocClient,
  requireEnv,
  type EventItem,
  type SeatItem,
  type SeatStatus,
} from "../../shared/src";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export interface PublicSeat {
  seatId: string;
  section: string;
  row: string;
  status: SeatStatus;
  expiresAt?: string;
}

/**
 * Catalog — GET /events/{eventId}/seats.
 * Public (no Cognito). Seat-map availability with optional cursor pagination.
 */
export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const eventsTable = requireEnv("EVENTS_TABLE_NAME");
  const seatsTable = requireEnv("SEATS_TABLE_NAME");

  const eventId = event.pathParameters?.eventId?.trim();
  if (!eventId) {
    return json(400, { message: "missing eventId path parameter" });
  }

  const limitResult = parseLimit(event.queryStringParameters?.limit);
  if (!limitResult.ok) {
    return json(400, { message: limitResult.message });
  }

  const tokenResult = decodeNextToken(event.queryStringParameters?.nextToken);
  if (!tokenResult.ok) {
    return json(400, { message: tokenResult.message });
  }

  const eventItem = await getEvent(eventsTable, eventId);
  if (!eventItem) {
    return json(404, { message: "event not found", eventId });
  }

  const queryOut = await getDocClient().send(
    new QueryCommand({
      TableName: seatsTable,
      KeyConditionExpression: "eventId = :eventId",
      ExpressionAttributeValues: { ":eventId": eventId },
      Limit: limitResult.limit,
      ExclusiveStartKey: tokenResult.key,
    }),
  );

  const seats = ((queryOut.Items ?? []) as SeatItem[]).map(toPublicSeat);
  const nextToken = encodeNextToken(queryOut.LastEvaluatedKey);

  return json(200, { eventId, seats, nextToken });
}

async function getEvent(
  tableName: string,
  eventId: string,
): Promise<EventItem | undefined> {
  const out = await getDocClient().send(
    new GetCommand({
      TableName: tableName,
      Key: { eventId },
    }),
  );
  return out.Item as EventItem | undefined;
}

function toPublicSeat(item: SeatItem): PublicSeat {
  const seat: PublicSeat = {
    seatId: item.seatId,
    section: item.section,
    row: item.row,
    status: item.status,
  };
  if (item.expiresAt != null) {
    seat.expiresAt = item.expiresAt;
  }
  return seat;
}

function parseLimit(
  raw: string | undefined,
): { ok: true; limit: number } | { ok: false; message: string } {
  if (raw == null || raw === "") {
    return { ok: true, limit: DEFAULT_LIMIT };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    return {
      ok: false,
      message: `limit must be an integer between 1 and ${MAX_LIMIT}`,
    };
  }
  return { ok: true, limit: n };
}

function encodeNextToken(
  key: Record<string, unknown> | undefined,
): string | null {
  if (!key) {
    return null;
  }
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

function decodeNextToken(
  raw: string | undefined | null,
):
  | { ok: true; key: Record<string, unknown> | undefined }
  | { ok: false; message: string } {
  if (raw == null || raw === "") {
    return { ok: true, key: undefined };
  }
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (
      parsed == null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return { ok: false, message: "invalid nextToken" };
    }
    return { ok: true, key: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, message: "invalid nextToken" };
  }
}

function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
