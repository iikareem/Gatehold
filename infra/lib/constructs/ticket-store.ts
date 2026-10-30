import * as cdk from "aws-cdk-lib";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface TicketStoreProps {
  stage: string;
  removalPolicy: cdk.RemovalPolicy;
}

/**
 * Phase 10a — signed ticket artifacts.
 *
 * Private S3 bucket holds `{ payload, signature }` JSON per ticket.
 * Asymmetric KMS key (SIGN_VERIFY) signs/verifies; private key never leaves KMS.
 * IssueTicket / get-order / verify wire grants in later slices.
 */
export class TicketStore extends Construct {
  readonly ticketsBucket: s3.Bucket;
  readonly signingKey: kms.Key;

  constructor(scope: Construct, id: string, props: TicketStoreProps) {
    super(scope, id);

    const { stage, removalPolicy } = props;
    const ephemeral = removalPolicy === cdk.RemovalPolicy.DESTROY;

    this.signingKey = new kms.Key(this, "TicketSigningKey", {
      alias: `alias/gatehold-${stage}-tickets`,
      description: `Gatehold ${stage} ticket digital signatures (SIGN_VERIFY)`,
      keySpec: kms.KeySpec.RSA_2048,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      enableKeyRotation: false, // asymmetric keys do not support automatic rotation
      removalPolicy,
    });


    this.ticketsBucket = new s3.Bucket(this, "TicketsBucket", {
      bucketName: `gatehold-${stage}-tickets`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy,
      autoDeleteObjects: ephemeral,
    });
  }
}
