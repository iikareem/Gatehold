import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type { APIGatewayProxyEvent } from "aws-lambda";
import * as dynamodb from "../../shared/src/dynamodb";
import { handler } from "./handler";

function listEventsRequest(
  overrides: {
    limit?: string | null;
    nextToken?: string | null;
  } = {},
): APIGatewayProxyEvent {
  const qs: Record<string, string> = {};
  if (overrides.limit != null) {
    qs.limit = overrides.limit;
  }
  if (overrides.nextToken != null) {
    qs.nextToken = overrides.nextToken;
  }
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: "GET",
    isBase64Encoded: false,
    path: "/events",
    pathParameters: null,
    queryStringParameters: Object.keys(qs).length > 0 ? qs : null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: "/events",
    requestContext: {} as APIGatewayProxyEvent["requestContext"],
  };
}

describe("list-events handler", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.EVENTS_TABLE_NAME;
  });

  it("returns 400 for invalid limit", async () => {
    process.env.EVENTS_TABLE_NAME = "gatehold-dev-events";
    const result = await handler(listEventsRequest({ limit: "0" }));
    assert.equal(result.statusCode, 400);
    assert.match(result.body, /limit must be/);
  });

  it("returns 400 for invalid nextToken", async () => {
    process.env.EVENTS_TABLE_NAME = "gatehold-dev-events";
    const result = await handler(listEventsRequest({ nextToken: "%%%" }));
    assert.equal(result.statusCode, 400);
    assert.match(result.body, /invalid nextToken/);
  });

  it("returns 200 with public event projection", async () => {
    process.env.EVENTS_TABLE_NAME = "gatehold-dev-events";
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => ({
        Items: [
          {
            eventId: "evt_001",
            name: "Gatehold Demo Night",
            status: "ON_SALE",
            createdAt: "2026-11-01T20:00:00.000Z",
            refundBatchId: "rb_secret",
          },
          {
            eventId: "evt_002",
            name: "Cancelled Show",
            status: "CANCELLED",
            createdAt: "2026-10-01T12:00:00.000Z",
            cancelledAt: "2026-10-15T09:00:00.000Z",
          },
        ],
      }),
    }));

    const result = await handler(listEventsRequest());
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.deepEqual(body.events, [
      {
        eventId: "evt_001",
        name: "Gatehold Demo Night",
        status: "ON_SALE",
        createdAt: "2026-11-01T20:00:00.000Z",
      },
      {
        eventId: "evt_002",
        name: "Cancelled Show",
        status: "CANCELLED",
        createdAt: "2026-10-01T12:00:00.000Z",
        cancelledAt: "2026-10-15T09:00:00.000Z",
      },
    ]);
    assert.equal(body.nextToken, null);
    assert.equal("refundBatchId" in body.events[0], false);
  });

  it("passes ExclusiveStartKey from nextToken on Scan", async () => {
    process.env.EVENTS_TABLE_NAME = "gatehold-dev-events";
    const lek = { eventId: "evt_001" };
    const token = Buffer.from(JSON.stringify(lek), "utf8").toString(
      "base64url",
    );
    let scanInput: Record<string, unknown> | undefined;
    mock.method(dynamodb, "getDocClient", () => ({
      send: async (cmd: { input: Record<string, unknown> }) => {
        scanInput = cmd.input;
        return {
          Items: [],
          LastEvaluatedKey: { eventId: "evt_050" },
        };
      },
    }));

    const result = await handler(
      listEventsRequest({ limit: "10", nextToken: token }),
    );
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.deepEqual(scanInput?.ExclusiveStartKey, lek);
    assert.equal(scanInput?.Limit, 10);
    assert.equal(typeof body.nextToken, "string");
  });
});
