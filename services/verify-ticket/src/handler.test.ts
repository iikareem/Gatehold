import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type { APIGatewayProxyEvent } from "aws-lambda";
import * as ticketVerify from "../../shared/src/ticket-verify";
import { handler } from "./handler";

const artifact = {
  payload: {
    ticketId: "tkt:ord_1:A-12-07",
    orderId: "ord_1",
    eventId: "evt_001",
    seatId: "A-12-07",
    userId: "alice",
  },
  signature: "sig-base64",
};

function verifyEvent(
  overrides: { body?: string | null } = {},
): APIGatewayProxyEvent {
  return {
    body:
      overrides.body === undefined
        ? JSON.stringify(artifact)
        : overrides.body,
    headers: {},
    multiValueHeaders: {},
    httpMethod: "POST",
    isBase64Encoded: false,
    path: "/tickets/verify",
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: "/tickets/verify",
    requestContext: {} as APIGatewayProxyEvent["requestContext"],
  };
}

function setEnv() {
  process.env.EVENTS_TABLE_NAME = "gatehold-dev-events";
  process.env.TICKET_SIGNING_KEY_ID = "key-test-id";
}

describe("verify-ticket handler", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.EVENTS_TABLE_NAME;
    delete process.env.TICKET_SIGNING_KEY_ID;
  });

  it("returns 400 for missing or invalid body", async () => {
    setEnv();
    const missing = await handler(verifyEvent({ body: null }));
    assert.equal(missing.statusCode, 400);

    const badPayload = await handler(
      verifyEvent({ body: JSON.stringify({ signature: "x" }) }),
    );
    assert.equal(badPayload.statusCode, 400);
  });

  it("returns valid true on accept", async () => {
    setEnv();
    mock.method(ticketVerify, "verifyTicketArtifact", async () => ({
      valid: true as const,
      payload: artifact.payload,
    }));

    const result = await handler(verifyEvent());
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body), {
      valid: true,
      ticketId: "tkt:ord_1:A-12-07",
      eventId: "evt_001",
      seatId: "A-12-07",
      orderId: "ord_1",
    });
  });

  it("returns valid false with reason on reject", async () => {
    setEnv();
    mock.method(ticketVerify, "verifyTicketArtifact", async () => ({
      valid: false as const,
      reason: "invalid_signature" as const,
    }));

    const result = await handler(verifyEvent());
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body), {
      valid: false,
      reason: "invalid_signature",
    });
  });

  it("surfaces event_cancelled from the helper", async () => {
    setEnv();
    mock.method(ticketVerify, "verifyTicketArtifact", async () => ({
      valid: false as const,
      reason: "event_cancelled" as const,
    }));

    const result = await handler(verifyEvent());
    assert.equal(JSON.parse(result.body).reason, "event_cancelled");
  });
});
