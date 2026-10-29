import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";

export interface AuthProps {
  stage: string;
  removalPolicy: cdk.RemovalPolicy;
}

/** Cognito group name for cancel / refund operators (admin TOKEN authorizer). */
export const ADMIN_GROUP_NAME = "admin";

/**
 * Cognito identity plane (pool + client + admin group).
 *
 * 9b Cognito authorizer validates any pool JWT on holds/orders.
 * 9c admin TOKEN authorizer also requires group `admin` on /admin/*.
 * Seed users with `npm run seed:auth` after deploy.
 */
export class Auth extends Construct {
  readonly userPool: cognito.IUserPool;
  readonly userPoolClient: cognito.IUserPoolClient;
  readonly adminGroup: cognito.IUserPoolGroup;
  /** Standard Cognito issuer URL (`iss` claim shape MiniStack mirrors). */
  readonly issuerUrl: string;

  constructor(scope: Construct, id: string, props: AuthProps) {
    super(scope, id);

    const { stage, removalPolicy } = props;

    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `gatehold-${stage}`,
      selfSignUpEnabled: false,
      signInAliases: { username: true },
      autoVerify: { email: false },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.NONE,
      removalPolicy,
    });

    this.userPool = userPool;

    this.userPoolClient = userPool.addClient("AppClient", {
      userPoolClientName: `gatehold-${stage}-app`,
      generateSecret: false,
      authFlows: {
        userPassword: true,
        adminUserPassword: true,
      },
    });

    this.adminGroup = userPool.addGroup("AdminGroup", {
      groupName: ADMIN_GROUP_NAME,
      description: "Gatehold operators (cancel / refund; enforced in 9c)",
      precedence: 0,
    });

    this.issuerUrl = `https://cognito-idp.${cdk.Stack.of(this).region}.amazonaws.com/${userPool.userPoolId}`;
  }
}
