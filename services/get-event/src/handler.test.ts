import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type { APIGatewayProxyEvent } from "aws-lambda";
import * as dynamodb from "../../shared/src/dynamodb";
import { handler } from "./handler";

function getEventRequest(
  eventId: string | null = "evt_001",
): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: "GET",
    isBase64Encoded: false,
    path: `/events/${eventId ?? ""}`,
    pathParameters: eventId ? { eventId } : null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: "/events/{eventId}",
    requestContext: {} as APIGatewayProxyEvent["requestContext"],
  };
}

describe("get-event handler", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.EVENTS_TABLE_NAME;
  });

  it("returns 400 when eventId path param is missing", async () => {
    process.env.EVENTS_TABLE_NAME = "gatehold-dev-events";
    const result = await handler(getEventRequest(null));
    assert.equal(result.statusCode, 400);
    assert.match(result.body, /missing eventId/);
  });

  it("returns 404 when event is missing", async () => {
    process.env.EVENTS_TABLE_NAME = "gatehold-dev-events";
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => ({ Item: undefined }),
    }));

    const result = await handler(getEventRequest("evt_missing"));
    assert.equal(result.statusCode, 404);
    const body = JSON.parse(result.body);
    assert.equal(body.message, "event not found");
    assert.equal(body.eventId, "evt_missing");
  });

  it("returns 200 with public event fields only", async () => {
    process.env.EVENTS_TABLE_NAME = "gatehold-dev-events";
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => ({
        Item: {
          eventId: "evt_001",
          name: "Gatehold Demo Night",
          status: "ON_SALE",
          createdAt: "2026-11-01T20:00:00.000Z",
          refundBatchId: "rb_secret",
        },
      }),
    }));

    const result = await handler(getEventRequest());
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.deepEqual(body, {
      eventId: "evt_001",
      name: "Gatehold Demo Night",
      status: "ON_SALE",
      createdAt: "2026-11-01T20:00:00.000Z",
    });
    assert.equal("refundBatchId" in body, false);
  });

  it("includes cancelledAt when set", async () => {
    process.env.EVENTS_TABLE_NAME = "gatehold-dev-events";
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => ({
        Item: {
          eventId: "evt_001",
          name: "Gatehold Demo Night",
          status: "CANCELLED",
          createdAt: "2026-11-01T20:00:00.000Z",
          cancelledAt: "2026-11-02T10:00:00.000Z",
        },
      }),
    }));

    const result = await handler(getEventRequest());
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.cancelledAt, "2026-11-02T10:00:00.000Z");
  });
});
