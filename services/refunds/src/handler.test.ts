import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type { APIGatewayProxyEvent } from "aws-lambda";
import * as dynamodb from "../../shared/src/dynamodb";
import { handler } from "./handler";

function refundsEvent(
  overrides: { eventId?: string | null } = {},
): APIGatewayProxyEvent {
  const eventId =
    overrides.eventId === null ? undefined : (overrides.eventId ?? "evt_001");
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: "GET",
    isBase64Encoded: false,
    path: `/admin/events/${eventId ?? ""}/refunds`,
    pathParameters: eventId ? { eventId } : null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: "/admin/events/{eventId}/refunds",
    requestContext: {} as APIGatewayProxyEvent["requestContext"],
  };
}

describe("refunds handler", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.EVENTS_TABLE_NAME;
    delete process.env.REFUND_BATCHES_TABLE_NAME;
  });

  it("returns 400 when eventId is missing", async () => {
    process.env.EVENTS_TABLE_NAME = "events";
    process.env.REFUND_BATCHES_TABLE_NAME = "refund-batches";
    const result = await handler(refundsEvent({ eventId: null }));
    assert.equal(result.statusCode, 400);
  });

  it("returns 404 when the event is missing", async () => {
    process.env.EVENTS_TABLE_NAME = "events";
    process.env.REFUND_BATCHES_TABLE_NAME = "refund-batches";
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => ({}),
    }));

    const result = await handler(refundsEvent());
    assert.equal(result.statusCode, 404);
  });

  it("returns batch null when refundBatchId is unset", async () => {
    process.env.EVENTS_TABLE_NAME = "events";
    process.env.REFUND_BATCHES_TABLE_NAME = "refund-batches";
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => ({
        Item: { eventId: "evt_001", status: "CANCELLING" },
      }),
    }));

    const result = await handler(refundsEvent());
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body), {
      eventId: "evt_001",
      eventStatus: "CANCELLING",
      batch: null,
    });
  });

  it("returns batch progress when refundBatchId is set", async () => {
    process.env.EVENTS_TABLE_NAME = "events";
    process.env.REFUND_BATCHES_TABLE_NAME = "refund-batches";
    let call = 0;
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => {
        call += 1;
        if (call === 1) {
          return {
            Item: {
              eventId: "evt_001",
              status: "CANCELLING",
              refundBatchId: "rb_1",
            },
          };
        }
        return {
          Item: {
            batchId: "rb_1",
            eventId: "evt_001",
            status: "RUNNING",
            enqueued: 10,
            succeeded: 7,
            failed: 1,
            fanOutComplete: true,
            startedAt: "2026-11-01T00:00:00.000Z",
          },
        };
      },
    }));

    const result = await handler(refundsEvent());
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body), {
      eventId: "evt_001",
      eventStatus: "CANCELLING",
      batchId: "rb_1",
      status: "RUNNING",
      enqueued: 10,
      succeeded: 7,
      failed: 1,
      fanOutComplete: true,
      startedAt: "2026-11-01T00:00:00.000Z",
      finishedAt: null,
    });
  });
});
