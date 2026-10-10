import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/**
 * DynamoDB client that honors AWS_ENDPOINT_URL (MiniStack / local emulator).
 * On real AWS, leave AWS_ENDPOINT_URL unset.
 */
export function createDynamoDBClient(): DynamoDBClient {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  const region =
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

  return new DynamoDBClient({
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

let cachedDocClient: DynamoDBDocumentClient | undefined;

export function getDocClient(): DynamoDBDocumentClient {
  if (!cachedDocClient) {
    cachedDocClient = DynamoDBDocumentClient.from(createDynamoDBClient(), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return cachedDocClient;
}
