import * as cdk from "aws-cdk-lib";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { dockerReachableEndpoint } from "../helpers/node-fn";

/** Defaults match today's hardcoded values (hold.ts / MAX_HOLD_SEATS). */
export const DEFAULT_HOLD_TTL_MS = String(5 * 60 * 1000);
export const DEFAULT_MAX_HOLD_SEATS = "8";
/** Placeholder until Phase 11 refund-worker consumes it. */
export const DEFAULT_REFUND_RATE = "1.0";

export interface ConfigProps {
  stage: string;
  removalPolicy: cdk.RemovalPolicy;
}

/**
 * Secrets Manager + SSM Parameter Store (Phase 9d).
 *
 * 9d.2 wires mock-payment secret into payment Lambdas.
 * 9d.3 wires SSM hold TTL / max seats (params exist from 9d.1).
 */
export class Config extends Construct {
  readonly mockPaymentSecret: secretsmanager.ISecret;
  /** Docker-reachable URL seeded into the secret (same rewrite as purchase-saga). */
  readonly mockPaymentUrl: string;

  readonly holdTtlMsParam: ssm.IStringParameter;
  readonly maxHoldSeatsParam: ssm.IStringParameter;
  readonly refundRateParam: ssm.IStringParameter;

  readonly holdTtlMsParamName: string;
  readonly maxHoldSeatsParamName: string;
  readonly refundRateParamName: string;

  constructor(scope: Construct, id: string, props: ConfigProps) {
    super(scope, id);

    const { stage, removalPolicy } = props;

    this.mockPaymentUrl = dockerReachableEndpoint(
      process.env.MOCK_PAYMENT_URL || "http://127.0.0.1:8090",
    );

    this.mockPaymentSecret = new secretsmanager.Secret(
      this,
      "MockPaymentSecret",
      {
        secretName: `gatehold-${stage}/mock-payment`,
        description: "Mock payment provider base URL (Phase 9d)",
        secretStringValue: cdk.SecretValue.unsafePlainText(this.mockPaymentUrl),
        removalPolicy,
      },
    );

    this.holdTtlMsParamName = `/gatehold/${stage}/hold-ttl-ms`;
    this.maxHoldSeatsParamName = `/gatehold/${stage}/max-hold-seats`;
    this.refundRateParamName = `/gatehold/${stage}/refund-rate`;

    this.holdTtlMsParam = new ssm.StringParameter(this, "HoldTtlMs", {
      parameterName: this.holdTtlMsParamName,
      stringValue: process.env.HOLD_TTL_MS || DEFAULT_HOLD_TTL_MS,
      description: "Seat hold duration in milliseconds",
      tier: ssm.ParameterTier.STANDARD,
    });

    this.maxHoldSeatsParam = new ssm.StringParameter(this, "MaxHoldSeats", {
      parameterName: this.maxHoldSeatsParamName,
      stringValue: process.env.MAX_HOLD_SEATS || DEFAULT_MAX_HOLD_SEATS,
      description: "Max seats per hold / order",
      tier: ssm.ParameterTier.STANDARD,
    });

    this.refundRateParam = new ssm.StringParameter(this, "RefundRate", {
      parameterName: this.refundRateParamName,
      stringValue: process.env.REFUND_RATE || DEFAULT_REFUND_RATE,
      description: "Refund worker concurrency rate (Phase 11)",
      tier: ssm.ParameterTier.STANDARD,
    });
  }
}
