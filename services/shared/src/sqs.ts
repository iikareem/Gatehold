import { SQSClient } from "@aws-sdk/client-sqs";
import { captureAwsV3Client } from "./xray";

/**
 * SQS client that honors AWS_ENDPOINT_URL (MiniStack / local emulator).
 * On real AWS, leave AWS_ENDPOINT_URL unset.
 * Phase 13c — X-Ray subsegments + Trace ID on SendMessage when Active Tracing.
 */
export function createSqsClient(): SQSClient {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  const region =
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

  return captureAwsV3Client(
    new SQSClient({
      region,
      ...(endpoint
        ? {
            endpoint,
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID || "test",
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "test",
            },
          }
        : {}),
    }),
  );
}

let cachedSqsClient: SQSClient | undefined;

export function getSqsClient(): SQSClient {
  if (!cachedSqsClient) {
    cachedSqsClient = createSqsClient();
  }
  return cachedSqsClient;
}
