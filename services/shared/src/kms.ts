import { KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { TICKET_SIGNING_ALGORITHM } from "./ticket";

/**
 * KMS client that honors AWS_ENDPOINT_URL (MiniStack / local emulator).
 */
export function createKmsClient(): KMSClient {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  const region =
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

  return new KMSClient({
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

let cachedClient: KMSClient | undefined;

export function getKmsClient(): KMSClient {
  if (!cachedClient) {
    cachedClient = createKmsClient();
  }
  return cachedClient;
}

/**
 * Sign a UTF-8 message with the ticket SIGN_VERIFY key.
 * Returns base64 signature (never exports the private key).
 */
export async function signTicketMessage(
  keyId: string,
  message: string,
  client: KMSClient = getKmsClient(),
): Promise<string> {
  const result = await client.send(
    new SignCommand({
      KeyId: keyId,
      Message: Buffer.from(message, "utf8"),
      MessageType: "RAW",
      SigningAlgorithm: TICKET_SIGNING_ALGORITHM,
    }),
  );
  if (!result.Signature || result.Signature.length === 0) {
    throw new Error("KMS Sign returned empty Signature");
  }
  return Buffer.from(result.Signature).toString("base64");
}
