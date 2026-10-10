#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { SeatLockStack } from "../lib/seatlock-stack";

const app = new cdk.App();
const stage = String(app.node.tryGetContext("stage") ?? "dev");

new SeatLockStack(app, `SeatLock-${stage}`, {
  stage,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
  },
  description: `SeatLock phase-0 foundation (${stage})`,
});
