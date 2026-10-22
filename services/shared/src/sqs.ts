import { SQSClient } from "@aws-sdk/client-sqs";

/**
 * SQS client that honors AWS_ENDPOINT_URL (MiniStack / local emulator).
 * On real AWS, leave AWS_ENDPOINT_URL unset.
 */
export function createSqsClient(): SQSClient {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  const region =
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

  return new SQSClient({
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
  });
}

let cachedSqsClient: SQSClient | undefined;

export function getSqsClient(): SQSClient {
  if (!cachedSqsClient) {
    cachedSqsClient = createSqsClient();
  }
  return cachedSqsClient;
}
