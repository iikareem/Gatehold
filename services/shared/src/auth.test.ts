import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { APIGatewayProxyEvent } from "aws-lambda";
import { callerUserId } from "./auth";

function eventWithAuthorizer(
  authorizer: APIGatewayProxyEvent["requestContext"]["authorizer"],
): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: "POST",
    isBase64Encoded: false,
    path: "/orders",
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: "/orders",
    requestContext: {
      authorizer,
    } as APIGatewayProxyEvent["requestContext"],
  };
}

describe("callerUserId", () => {
  it("reads sub from authorizer.claims", () => {
    const id = callerUserId(
      eventWithAuthorizer({
        claims: { sub: "abc-123", "cognito:username": "alice" },
      }),
    );
    assert.equal(id, "abc-123");
  });

  it("reads flattened authorizer.sub", () => {
    const id = callerUserId(eventWithAuthorizer({ sub: "flat-sub" }));
    assert.equal(id, "flat-sub");
  });

  it("returns undefined when authorizer is missing", () => {
    assert.equal(callerUserId(eventWithAuthorizer(undefined)), undefined);
  });

  it("ignores X-User-Id headers (no stub)", () => {
    const event = eventWithAuthorizer(undefined);
    event.headers = { "X-User-Id": "alice" };
    assert.equal(callerUserId(event), undefined);
  });
});
