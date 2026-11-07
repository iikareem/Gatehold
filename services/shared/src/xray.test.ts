import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { annotateTrace, captureAwsV3Client } from "./xray";

describe("annotateTrace", () => {
  it("does not throw when no X-Ray segment is open", () => {
    assert.doesNotThrow(() =>
      annotateTrace({ orderId: "ord_test", holdId: "h_test" }),
    );
  });
});

describe("captureAwsV3Client", () => {
  it("wraps an SDK v3 client without throwing", () => {
    const client = new DynamoDBClient({ region: "us-east-1" });
    const wrapped = captureAwsV3Client(client);
    assert.equal(typeof wrapped.send, "function");
  });
});
