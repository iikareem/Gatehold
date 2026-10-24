import { SFNClient } from "@aws-sdk/client-sfn";

/**
 * Step Functions client that honors AWS_ENDPOINT_URL (MiniStack / local emulator).
 * On real AWS, leave AWS_ENDPOINT_URL unset.
 */
export function createSfnClient(): SFNClient {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  const region =
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

  return new SFNClient({
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

let cachedSfnClient: SFNClient | undefined;

export function getSfnClient(): SFNClient {
  if (!cachedSfnClient) {
    cachedSfnClient = createSfnClient();
  }
  return cachedSfnClient;
}
