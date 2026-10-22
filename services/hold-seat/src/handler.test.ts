import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type { APIGatewayProxyEvent } from "aws-lambda";
import * as dynamodb from "../../shared/src/dynamodb";
import { handler } from "./handler";

function holdEvent(
  overrides: {
    eventId?: string | null;
    body?: string | null;
    headers?: Record<string, string>;
  } = {},
): APIGatewayProxyEvent {
  const eventId =
    overrides.eventId === null ? undefined : (overrides.eventId ?? "evt_001");
  return {
    body:
      overrides.body === undefined
        ? JSON.stringify({ seatIds: ["A-12-07"] })
        : overrides.body,
    headers: overrides.headers ?? { "X-User-Id": "alice" },
    multiValueHeaders: {},
    httpMethod: "POST",
    isBase64Encoded: false,
    path: `/events/${eventId ?? ""}/holds`,
    pathParameters: eventId ? { eventId } : null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: "/events/{eventId}/holds",
    requestContext: {} as APIGatewayProxyEvent["requestContext"],
  };
}

describe("hold-seat handler", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.SEATS_TABLE_NAME;
  });

  it("returns 201 when the conditional update succeeds", async () => {
    process.env.SEATS_TABLE_NAME = "gatehold-dev-seats";
    const send = mock.fn(async () => ({}));
    mock.method(dynamodb, "getDocClient", () => ({ send }));

    const result = await handler(holdEvent());

    assert.equal(result.statusCode, 201);
    const body = JSON.parse(result.body);
    assert.equal(body.seatIds[0], "A-12-07");
    assert.match(body.holdId, /^h_/);
    assert.ok(body.expiresAt);
    assert.equal(send.mock.callCount(), 1);
  });

  it("returns 409 when the transaction is canceled (live hold)", async () => {
    process.env.SEATS_TABLE_NAME = "gatehold-dev-seats";
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => {
        const err = new Error("Transaction cancelled");
        err.name = "TransactionCanceledException";
        throw err;
      },
    }));

    const result = await handler(holdEvent());

    assert.equal(result.statusCode, 409);
    const body = JSON.parse(result.body);
    assert.deepEqual(body.seatIds, ["A-12-07"]);
  });

  it("returns 400 when seatIds is empty or over the cap", async () => {
    process.env.SEATS_TABLE_NAME = "gatehold-dev-seats";
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => {
        throw new Error("should not call DynamoDB");
      },
    }));

    const empty = await handler(
      holdEvent({ body: JSON.stringify({ seatIds: [] }) }),
    );
    assert.equal(empty.statusCode, 400);

    const nine = Array.from({ length: 9 }, (_, i) => `A-12-0${i + 1}`);
    const tooMany = await handler(
      holdEvent({ body: JSON.stringify({ seatIds: nine }) }),
    );
    assert.equal(tooMany.statusCode, 400);
  });

  it("returns 201 for multiple seatIds via one TransactWrite", async () => {
    process.env.SEATS_TABLE_NAME = "gatehold-dev-seats";
    const send = mock.fn(async () => ({}));
    mock.method(dynamodb, "getDocClient", () => ({ send }));

    const seatIds = ["A-12-01", "A-12-02"];
    const result = await handler(
      holdEvent({ body: JSON.stringify({ seatIds }) }),
    );

    assert.equal(result.statusCode, 201);
    const body = JSON.parse(result.body);
    assert.deepEqual(body.seatIds, seatIds);
    assert.match(body.holdId, /^h_/);
    assert.equal(send.mock.callCount(), 1);
  });

  it("returns 409 for multi-seat when the transaction is canceled", async () => {
    process.env.SEATS_TABLE_NAME = "gatehold-dev-seats";
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => {
        const err = new Error("Transaction cancelled");
        err.name = "TransactionCanceledException";
        throw err;
      },
    }));

    const seatIds = ["A-12-02", "A-12-03"];
    const result = await handler(
      holdEvent({ body: JSON.stringify({ seatIds }) }),
    );

    assert.equal(result.statusCode, 409);
    const body = JSON.parse(result.body);
    assert.deepEqual(body.seatIds, seatIds);
    assert.equal(body.eventId, "evt_001");
  });

  it("returns 400 when a seatId entry is empty", async () => {
    process.env.SEATS_TABLE_NAME = "gatehold-dev-seats";
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => {
        throw new Error("should not call DynamoDB");
      },
    }));

    const result = await handler(
      holdEvent({ body: JSON.stringify({ seatIds: ["A-12-01", ""] }) }),
    );
    assert.equal(result.statusCode, 400);
  });

  it("returns 400 when eventId is missing", async () => {
    process.env.SEATS_TABLE_NAME = "gatehold-dev-seats";
    const result = await handler(holdEvent({ eventId: null }));
    assert.equal(result.statusCode, 400);
  });
});
