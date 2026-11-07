import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type { APIGatewayProxyEvent } from "aws-lambda";
import * as dynamodb from "../../shared/src/dynamodb";
import { handler } from "./handler";

function getSeatsRequest(
  overrides: {
    eventId?: string | null;
    limit?: string | null;
    nextToken?: string | null;
  } = {},
): APIGatewayProxyEvent {
  const eventId =
    overrides.eventId === null ? undefined : (overrides.eventId ?? "evt_001");
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
    path: `/events/${eventId ?? ""}/seats`,
    pathParameters: eventId ? { eventId } : null,
    queryStringParameters: Object.keys(qs).length > 0 ? qs : null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: "/events/{eventId}/seats",
    requestContext: {} as APIGatewayProxyEvent["requestContext"],
  };
}

function setEnv() {
  process.env.EVENTS_TABLE_NAME = "gatehold-dev-events";
  process.env.SEATS_TABLE_NAME = "gatehold-dev-seats";
}

describe("get-seats handler", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.EVENTS_TABLE_NAME;
    delete process.env.SEATS_TABLE_NAME;
  });

  it("returns 400 when eventId path param is missing", async () => {
    setEnv();
    const result = await handler(getSeatsRequest({ eventId: null }));
    assert.equal(result.statusCode, 400);
    assert.match(result.body, /missing eventId/);
  });

  it("returns 400 for invalid limit", async () => {
    setEnv();
    const result = await handler(getSeatsRequest({ limit: "0" }));
    assert.equal(result.statusCode, 400);
    assert.match(result.body, /limit must be/);
  });

  it("returns 400 for invalid nextToken", async () => {
    setEnv();
    const result = await handler(getSeatsRequest({ nextToken: "%%%" }));
    assert.equal(result.statusCode, 400);
    assert.match(result.body, /invalid nextToken/);
  });

  it("returns 404 when event is missing", async () => {
    setEnv();
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => ({ Item: undefined }),
    }));

    const result = await handler(getSeatsRequest());
    assert.equal(result.statusCode, 404);
    const body = JSON.parse(result.body);
    assert.equal(body.message, "event not found");
  });

  it("returns 200 with public seat projection and nextToken", async () => {
    setEnv();
    let call = 0;
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => {
        call += 1;
        if (call === 1) {
          return {
            Item: {
              eventId: "evt_001",
              name: "Demo",
              status: "ON_SALE",
              createdAt: "2026-11-01T20:00:00.000Z",
            },
          };
        }
        return {
          Items: [
            {
              eventId: "evt_001",
              seatId: "A-12-01",
              section: "A",
              row: "12",
              status: "AVAILABLE",
              version: 1,
            },
            {
              eventId: "evt_001",
              seatId: "A-12-07",
              section: "A",
              row: "12",
              status: "HELD",
              holdId: "h_secret",
              holdOwner: "alice-sub",
              expiresAt: "2026-11-01T20:05:00.000Z",
              orderId: "ord_x",
              payUntil: "2026-11-01T20:10:00.000Z",
              version: 2,
            },
          ],
          LastEvaluatedKey: { eventId: "evt_001", seatId: "A-12-07" },
        };
      },
    }));

    const result = await handler(getSeatsRequest({ limit: "2" }));
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.eventId, "evt_001");
    assert.deepEqual(body.seats, [
      {
        seatId: "A-12-01",
        section: "A",
        row: "12",
        status: "AVAILABLE",
      },
      {
        seatId: "A-12-07",
        section: "A",
        row: "12",
        status: "HELD",
        expiresAt: "2026-11-01T20:05:00.000Z",
      },
    ]);
    assert.equal(typeof body.nextToken, "string");
    assert.ok(body.nextToken.length > 0);

    const decoded = JSON.parse(
      Buffer.from(body.nextToken, "base64url").toString("utf8"),
    );
    assert.deepEqual(decoded, { eventId: "evt_001", seatId: "A-12-07" });
  });

  it("passes ExclusiveStartKey from nextToken on Query", async () => {
    setEnv();
    const lek = { eventId: "evt_001", seatId: "A-12-25" };
    const token = Buffer.from(JSON.stringify(lek), "utf8").toString(
      "base64url",
    );
    let queryInput: Record<string, unknown> | undefined;
    let call = 0;
    mock.method(dynamodb, "getDocClient", () => ({
      send: async (cmd: { input: Record<string, unknown> }) => {
        call += 1;
        if (call === 1) {
          return {
            Item: {
              eventId: "evt_001",
              name: "Demo",
              status: "ON_SALE",
              createdAt: "2026-11-01T20:00:00.000Z",
            },
          };
        }
        queryInput = cmd.input;
        return { Items: [], LastEvaluatedKey: undefined };
      },
    }));

    const result = await handler(getSeatsRequest({ nextToken: token }));
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.nextToken, null);
    assert.deepEqual(queryInput?.ExclusiveStartKey, lek);
    assert.equal(queryInput?.Limit, 100);
  });
});
