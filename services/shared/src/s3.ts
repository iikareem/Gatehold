import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { TicketArtifact } from "./ticket";

/** Default TTL for GET /orders/{orderId} ticket download links (Phase 10c). */
export const DEFAULT_TICKET_DOWNLOAD_TTL_SECONDS = 900;

/**
 * S3 client that honors AWS_ENDPOINT_URL (MiniStack / local emulator).
 * forcePathStyle helps LocalStack-compatible hosts from Lambda containers.
 */
export function createS3Client(): S3Client {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  const region =
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

  return new S3Client({
    region,
    forcePathStyle: Boolean(endpoint),
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

let cachedClient: S3Client | undefined;

export function getS3Client(): S3Client {
  if (!cachedClient) {
    cachedClient = createS3Client();
  }
  return cachedClient;
}

/** Put a signed ticket JSON artifact at the given bucket/key. */
export async function putTicketArtifact(
  params: {
    bucket: string;
    key: string;
    artifact: TicketArtifact;
  },
  client: S3Client = getS3Client(),
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
      Body: JSON.stringify(params.artifact),
      ContentType: "application/json",
    }),
  );
}

/**
 * Short-lived HTTPS URL for GetObject on a private ticket artifact.
 * Caller must already have authorized the download (order owner + CONFIRMED).
 */
export async function presignTicketGetUrl(
  params: {
    bucket: string;
    key: string;
    expiresInSeconds?: number;
  },
  client: S3Client = getS3Client(),
): Promise<string> {
  const expiresIn =
    params.expiresInSeconds ?? DEFAULT_TICKET_DOWNLOAD_TTL_SECONDS;
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
    }),
    { expiresIn },
  );
}
