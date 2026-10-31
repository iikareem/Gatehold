import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type { APIGatewayProxyEvent } from "aws-lambda";
import * as dynamodb from "../../shared/src/dynamodb";
import { handler } from "./handler";

function cancelEvent(
  overrides: { eventId?: string | null } = {},
): APIGatewayProxyEvent {
  const eventId =
    overrides.eventId === null ? undefined : (overrides.eventId ?? "evt_001");
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: "POST",
    isBase64Encoded: false,
    path: `/admin/events/${eventId ?? ""}/cancel`,
    pathParameters: eventId ? { eventId } : null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: "/admin/events/{eventId}/cancel",
    requestContext: {} as APIGatewayProxyEvent["requestContext"],
  };
}

describe("cancel handler", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.EVENTS_TABLE_NAME;
  });

  it("returns 400 when eventId is missing", async () => {
    process.env.EVENTS_TABLE_NAME = "gatehold-dev-events";
    const result = await handler(cancelEvent({ eventId: null }));
    assert.equal(result.statusCode, 400);
  });

  it("returns 200 CANCELLING when the conditional update succeeds", async () => {
    process.env.EVENTS_TABLE_NAME = "gatehold-dev-events";
    const send = mock.fn(async () => ({}));
    mock.method(dynamodb, "getDocClient", () => ({ send }));

    const result = await handler(cancelEvent());

    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body), {
      eventId: "evt_001",
      status: "CANCELLING",
    });
    assert.equal(send.mock.callCount(), 1);
  });

  it("returns 409 when the event is not ON_SALE", async () => {
    process.env.EVENTS_TABLE_NAME = "gatehold-dev-events";
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => {
        const err = new Error("The conditional request failed");
        err.name = "ConditionalCheckFailedException";
        throw err;
      },
    }));

    const result = await handler(cancelEvent());

    assert.equal(result.statusCode, 409);
    const body = JSON.parse(result.body);
    assert.equal(body.eventId, "evt_001");
    assert.match(body.message, /not on sale/i);
  });
});
