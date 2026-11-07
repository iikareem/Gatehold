import AWSXRay from "aws-xray-sdk-core";

// Unit tests / MiniStack often have no open segment — never crash or spam logs.
AWSXRay.setContextMissingStrategy("IGNORE_ERROR");

/**
 * Wrap an AWS SDK v3 client so calls become X-Ray subsegments when a
 * segment exists (Lambda Active Tracing). Safe to use in tests / MiniStack.
 */
export function captureAwsV3Client<T extends object>(client: T): T {
  // SDK typings for captureAWSv3Client are narrower than generic T.
  return AWSXRay.captureAWSv3Client(client as never) as T;
}

/**
 * Add searchable X-Ray annotations (e.g. orderId). No-ops when there is no
 * open segment — unit tests and incomplete local traces must not throw.
 */
export function annotateTrace(
  fields: Record<string, string | number | boolean>,
): void {
  try {
    const segment = AWSXRay.getSegment();
    if (!segment) return;
    for (const [key, value] of Object.entries(fields)) {
      segment.addAnnotation(key, value);
    }
  } catch {
    // Never fail the business path for tracing.
  }
}
