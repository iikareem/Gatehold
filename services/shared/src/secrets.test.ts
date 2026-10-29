import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mockPaymentBaseUrl, resetSecretsCacheForTests } from "./secrets";

describe("mockPaymentBaseUrl", () => {
  afterEach(() => {
    delete process.env.MOCK_PAYMENT_URL;
    delete process.env.MOCK_PAYMENT_SECRET_ARN;
    resetSecretsCacheForTests();
  });

  it("uses MOCK_PAYMENT_URL override when set (unit tests)", async () => {
    process.env.MOCK_PAYMENT_URL = "http://127.0.0.1:8090/";
    assert.equal(await mockPaymentBaseUrl(), "http://127.0.0.1:8090");
  });

  it("requires MOCK_PAYMENT_SECRET_ARN when override is absent", async () => {
    await assert.rejects(
      () => mockPaymentBaseUrl(),
      /MOCK_PAYMENT_SECRET_ARN/,
    );
  });
});
