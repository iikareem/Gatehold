/**
 * Seed one event and a small seat map for local development.
 *
 * Usage (MiniStack running, stack deployed):
 *   npm run seed
 *
 * Env (see .env.example):
 *   AWS_ENDPOINT_URL, EVENTS_TABLE_NAME, SEATS_TABLE_NAME, SEED_EVENT_ID
 */

import { PutCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  EventItem,
  SeatItem,
  formatSeatId,
  getDocClient,
  optionalEnv,
  requireEnv,
} from "../services/shared/src";

const EVENT_ID = optionalEnv("SEED_EVENT_ID", "evt_001");
const SECTION = "A";
const ROW = "12";
const SEAT_COUNT = 50;

async function main(): Promise<void> {
  const eventsTable = requireEnv("EVENTS_TABLE_NAME");
  const seatsTable = requireEnv("SEATS_TABLE_NAME");
  const doc = getDocClient();
  const now = new Date().toISOString();

  const event: EventItem = {
    eventId: EVENT_ID,
    status: "ON_SALE",
    name: "Gatehold Demo Night",
    createdAt: now,
  };

  await doc.send(
    new PutCommand({
      TableName: eventsTable,
      Item: event,
    }),
  );

  const seats: SeatItem[] = [];
  for (let n = 1; n <= SEAT_COUNT; n++) {
    seats.push({
      eventId: EVENT_ID,
      seatId: formatSeatId(SECTION, ROW, n),
      status: "AVAILABLE",
      section: SECTION,
      row: ROW,
      version: 1,
    });
  }

  // BatchWrite max 25 items per request
  for (let i = 0; i < seats.length; i += 25) {
    const chunk = seats.slice(i, i + 25);
    await doc.send(
      new BatchWriteCommand({
        RequestItems: {
          [seatsTable]: chunk.map((item) => ({
            PutRequest: { Item: item },
          })),
        },
      }),
    );
  }

  // Phase 8d: SES sandbox / MiniStack reject unverified From (and often To).
  const sesFrom = optionalEnv("SES_FROM_EMAIL", "noreply@gatehold.local");
  const sesVerified = await verifySesEmails([
    sesFrom,
    "alice@fans.gatehold.local",
  ]);

  console.log(
    JSON.stringify(
      {
        ok: true,
        eventId: EVENT_ID,
        seats: SEAT_COUNT,
        sampleSeatId: formatSeatId(SECTION, ROW, 1),
        tables: { events: eventsTable, seats: seatsTable },
        sesVerified,
        endpoint: process.env.AWS_ENDPOINT_URL || "(default AWS)",
      },
      null,
      2,
    ),
  );
}

/** Best-effort VerifyEmailIdentity against MiniStack (no-op / skip if no endpoint). */
async function verifySesEmails(addresses: string[]): Promise<string[]> {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  if (!endpoint) {
    return [];
  }
  const verified: string[] = [];
  for (const email of addresses) {
    const body = new URLSearchParams({
      Action: "VerifyEmailIdentity",
      Version: "2010-12-01",
      EmailAddress: email,
    });
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`SES VerifyEmailIdentity ${email}: ${res.status} ${text}`);
    }
    verified.push(email);
  }
  return verified;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
