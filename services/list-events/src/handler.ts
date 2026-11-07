import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import {
  getDocClient,
  requireEnv,
  type EventItem,
  type EventStatus,
} from "../../shared/src";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface PublicEvent {
  eventId: string;
  name: string;
  status: EventStatus;
  createdAt: string;
  cancelledAt?: string;
}

/**
 * Catalog — GET /events.
 * Public (no Cognito). List events for the seat-map landing page.
 * Events table is PK-only → Scan (fine at portfolio scale).
 */
export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const eventsTable = requireEnv("EVENTS_TABLE_NAME");

  const limitResult = parseLimit(event.queryStringParameters?.limit);
  if (!limitResult.ok) {
    return json(400, { message: limitResult.message });
  }

  const tokenResult = decodeNextToken(event.queryStringParameters?.nextToken);
  if (!tokenResult.ok) {
    return json(400, { message: tokenResult.message });
  }

  const scanOut = await getDocClient().send(
    new ScanCommand({
      TableName: eventsTable,
      Limit: limitResult.limit,
      ExclusiveStartKey: tokenResult.key,
    }),
  );

  const events = ((scanOut.Items ?? []) as EventItem[]).map(toPublicEvent);
  const nextToken = encodeNextToken(scanOut.LastEvaluatedKey);

  return json(200, { events, nextToken });
}

function toPublicEvent(item: EventItem): PublicEvent {
  const out: PublicEvent = {
    eventId: item.eventId,
    name: item.name,
    status: item.status,
    createdAt: item.createdAt,
  };
  if (item.cancelledAt != null) {
    out.cancelledAt = item.cancelledAt;
  }
  return out;
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
