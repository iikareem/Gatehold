import { KMSClient, SignCommand, VerifyCommand } from "@aws-sdk/client-kms";
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

/**
 * Verify a base64 signature over a UTF-8 message with the ticket key.
 * Returns false for invalid / mismatched signatures (does not throw).
 */
export async function verifyTicketMessage(
  keyId: string,
  message: string,
  signatureBase64: string,
  client: KMSClient = getKmsClient(),
): Promise<boolean> {
  try {
    const result = await client.send(
      new VerifyCommand({
        KeyId: keyId,
        Message: Buffer.from(message, "utf8"),
        MessageType: "RAW",
        Signature: Buffer.from(signatureBase64, "base64"),
        SigningAlgorithm: TICKET_SIGNING_ALGORITHM,
      }),
    );
    return result.SignatureValid === true;
  } catch (err) {
    if (isInvalidSignatureError(err)) {
      return false;
    }
    throw err;
  }
}

function isInvalidSignatureError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return (
    name === "KMSInvalidSignatureException" ||
    name === "InvalidSignatureException" ||
    name === "InvalidCiphertextException"
  );
}
