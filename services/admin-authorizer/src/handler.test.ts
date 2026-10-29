import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type { APIGatewayTokenAuthorizerEvent } from "aws-lambda";
import * as jwtVerify from "aws-jwt-verify";
import { handler, resetVerifierForTests } from "./handler";

function authEvent(
  authorizationToken: string,
): APIGatewayTokenAuthorizerEvent {
  return {
    type: "TOKEN",
    methodArn:
      "arn:aws:execute-api:us-east-1:000000000000:api/dev/POST/admin/events/evt_001/cancel",
    authorizationToken,
  };
}

describe("admin-authorizer", () => {
  afterEach(() => {
    mock.restoreAll();
    resetVerifierForTests();
    delete process.env.USER_POOL_ID;
    delete process.env.USER_POOL_CLIENT_ID;
    delete process.env.USER_POOL_ISSUER;
    delete process.env.ADMIN_GROUP_NAME;
    delete process.env.AWS_ENDPOINT_URL;
  });

  function setEnv() {
    process.env.USER_POOL_ID = "us-east-1_test";
    process.env.USER_POOL_CLIENT_ID = "client123";
    process.env.USER_POOL_ISSUER =
      "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test";
  }

  it("throws Unauthorized when Bearer token is missing", async () => {
    setEnv();
    await assert.rejects(() => handler(authEvent("")), /Unauthorized/);
  });

  it("throws Unauthorized when JWT verify fails", async () => {
    setEnv();
    mock.method(jwtVerify.JwtVerifier, "create", () => ({
      verify: async () => {
        throw new Error("bad token");
      },
    }));

    await assert.rejects(
      () => handler(authEvent("Bearer eyJbad")),
      /Unauthorized/,
    );
  });

  it("returns Deny when caller is not in admin group", async () => {
    setEnv();
    mock.method(jwtVerify.JwtVerifier, "create", () => ({
      verify: async () => ({
        sub: "fan-sub",
        "cognito:username": "alice",
        "cognito:groups": [],
      }),
    }));

    const result = await handler(authEvent("Bearer fan.jwt"));
    assert.equal(result.policyDocument.Statement[0]?.Effect, "Deny");
    assert.equal(result.principalId, "fan-sub");
  });

  it("returns Allow when cognito:groups includes admin", async () => {
    setEnv();
    mock.method(jwtVerify.JwtVerifier, "create", () => ({
      verify: async () => ({
        sub: "admin-sub",
        "cognito:username": "admin",
        "cognito:groups": ["admin"],
      }),
    }));

    const result = await handler(authEvent("Bearer admin.jwt"));
    assert.equal(result.policyDocument.Statement[0]?.Effect, "Allow");
    assert.equal(result.principalId, "admin-sub");
    assert.equal(result.context?.sub, "admin-sub");
    assert.equal(result.context?.groups, "admin");
  });
});
