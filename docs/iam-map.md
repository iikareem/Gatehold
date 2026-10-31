# IAM permission map (Phase 9d.4)

Least-privilege snapshot after the 9d.4 audit. Grants live at construct edges
(`hold-capability`, `order-accept`, `purchase-saga`, `http-api`, `domain-events`,
`config`, `ticket-store`). Prefer CDK `grant*` helpers; add explicit statements
only when the helper is too wide or missing an action the call graph needs.

**Phase 10 (done):** `TicketStore` provisions tickets bucket + signing key.
- **issue-ticket (10b):** S3 `PutObject` tickets · KMS `Sign`
- **get-order (10c):** DynamoDB **R** orders · S3 `GetObject` / presign tickets
- **verify-ticket (10d):** KMS `Verify` · DynamoDB **R** events

**Legend:** R = read · W = write (+ `TransactWriteItems` where noted) · RW = read+write

| Lambda | AWS actions / resources |
|---|---|
| **health** | DynamoDB **R** seats (`GetItem` for `?eventId=&seatId=`) |
| **hold-seat** | DynamoDB **R** events (ConditionCheck ON_SALE) · **W+Transact** seats · SSM **GetParameter** hold-ttl + max-seats |
| **hold-sweeper** | DynamoDB **RW** seats (`Scan` + `UpdateItem`) |
| **create-order** | DynamoDB **R** events · **W+Transact** seats · **W+Transact** orders · **RW** idempotency · SQS **SendMessage** orders queue · SSM **GetParameter** max-seats |
| **get-order** | DynamoDB **R** orders · S3 **GetObject** tickets bucket (presigned download URLs) |
| **verify-ticket** | DynamoDB **R** events · KMS **Verify** ticket key |
| **saga-starter** | DynamoDB **W** orders (`UpdateItem` executionArn) · SFN **StartExecution** purchase saga · SQS consume (event source) |
| **verify-hold** | DynamoDB **R** events, seats, orders |
| **authorize-payment** | DynamoDB **W** ledger (`PutItem`) · **W** orders (`UpdateItem` amount) · Secrets Manager **GetSecretValue** mock-payment |
| **capture-payment** | DynamoDB **W** ledger · Secrets Manager **GetSecretValue** mock-payment |
| **void-authorization** | DynamoDB **W** ledger · Secrets Manager **GetSecretValue** mock-payment |
| **refund-payment** | DynamoDB **W** ledger · Secrets Manager **GetSecretValue** mock-payment |
| **confirm-seat** | DynamoDB **W+Transact** seats |
| **release-seat** | DynamoDB **W+Transact** seats |
| **issue-ticket** | DynamoDB **W** orders · S3 **PutObject** tickets bucket · KMS **Sign** ticket key |
| **mark-confirmed** | DynamoDB **W** orders |
| **mark-failed** | DynamoDB **W** orders |
| **mark-refunded** | DynamoDB **W** orders |
| **stream-relay** | DynamoDB **stream read** orders · EventBridge **PutEvents** domain bus |
| **order-confirmed-logger** | (logs only — invoked by EventBridge rule) |
| **notify-email** | SES **SendEmail/SendRawEmail** on From identity `noreply@gatehold.local` · SES **VerifyEmailIdentity** `*` (sandbox From+To) · SQS consume notifications |
| **admin-authorizer** | (JWT verify in-process — no AWS data plane grants) |
| **cancel** | DynamoDB **W** events (`ON_SALE → CANCELLING`) |
| **refunds (GET)** | stub `501` until 11e — no data-plane grants yet |

## 9d.4 changes (what got narrower)

- **notify-email:** `ses:Send*` no longer on `*` — scoped to the From identity ARN. `VerifyEmailIdentity` stays `*` because To addresses are per-fan.
- **health:** dropped unused events-table read grant.
- **Write-only steps:** saga-starter, authorize (orders+ledger), capture/void/refund (ledger), issue/mark-\* (orders) use `grantWriteData` instead of `grantReadWriteData` (no Scan/Query/Get).
- **Transact writers:** hold-seat, create-order (seats/orders), confirm-seat, release-seat use `grantTableWriteWithTransact` so IAM matches `TransactWriteItems` (CDK `grantWriteData` alone omits that action).
- **hold-sweeper** keeps **RW** (needs `Scan`).
- **create-order** idempotency stays **RW** (Put + Get conflict path + Update).
- **Secrets / SSM** grants stay as introduced in 9d.2 / 9d.3 (already least-privilege).
