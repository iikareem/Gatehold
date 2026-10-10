/**
 * Read one seat from DynamoDB (host-side smoke test for Phase 0).
 *
 *   npm run get-seat
 *   SEED_EVENT_ID=evt_001 SEAT_ID=A-12-01 npm run get-seat
 */

import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  getDocClient,
  optionalEnv,
  requireEnv,
} from "../services/shared/src";

async function main(): Promise<void> {
  const seatsTable = requireEnv("SEATS_TABLE_NAME");
  const eventId = optionalEnv("SEED_EVENT_ID", "evt_001");
  const seatId = optionalEnv("SEAT_ID", "A-12-01");

  const result = await getDocClient().send(
    new GetCommand({
      TableName: seatsTable,
      Key: { eventId, seatId },
    }),
  );

  if (!result.Item) {
    console.error(`Seat not found: ${eventId} / ${seatId}`);
    process.exit(1);
  }

  console.log(JSON.stringify(result.Item, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
