package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/service/eventbridge"
)

func TestConfirmedFromRecord_PendingToConfirmed(t *testing.T) {
	record := events.DynamoDBEventRecord{
		EventID:   "stream-1",
		EventName: "MODIFY",
		Change: events.DynamoDBStreamRecord{
			OldImage: map[string]events.DynamoDBAttributeValue{
				"status": events.NewStringAttribute("PENDING"),
			},
			NewImage: map[string]events.DynamoDBAttributeValue{
				"orderId": events.NewStringAttribute("ord_1"),
				"eventId": events.NewStringAttribute("evt_001"),
				"userId":  events.NewStringAttribute("fan-1"),
				"status":  events.NewStringAttribute("CONFIRMED"),
				"seatIds": events.NewListAttribute([]events.DynamoDBAttributeValue{
					events.NewStringAttribute("A-12-01"),
					events.NewStringAttribute("A-12-02"),
				}),
			},
		},
	}

	c, ok := confirmedFromRecord(record)
	if !ok {
		t.Fatal("expected confirmed candidate")
	}
	if c.OrderID != "ord_1" || c.EventID != "evt_001" || c.UserID != "fan-1" {
		t.Fatalf("unexpected ids: %+v", c)
	}
	if len(c.SeatIDs) != 2 || c.SeatIDs[0] != "A-12-01" {
		t.Fatalf("unexpected seatIds: %v", c.SeatIDs)
	}
	if c.StreamID != "stream-1" {
		t.Fatalf("stream id: %s", c.StreamID)
	}
}

func TestConfirmedFromRecord_IgnoresNoise(t *testing.T) {
	cases := []events.DynamoDBEventRecord{
		{EventName: "INSERT", Change: events.DynamoDBStreamRecord{
			NewImage: map[string]events.DynamoDBAttributeValue{
				"status": events.NewStringAttribute("PENDING"),
			},
		}},
		{EventName: "MODIFY", Change: events.DynamoDBStreamRecord{
			OldImage: map[string]events.DynamoDBAttributeValue{
				"status": events.NewStringAttribute("PENDING"),
			},
			NewImage: map[string]events.DynamoDBAttributeValue{
				"status": events.NewStringAttribute("FAILED"),
			},
		}},
		{EventName: "MODIFY", Change: events.DynamoDBStreamRecord{
			OldImage: map[string]events.DynamoDBAttributeValue{
				"status": events.NewStringAttribute("CONFIRMED"),
			},
			NewImage: map[string]events.DynamoDBAttributeValue{
				"status": events.NewStringAttribute("CONFIRMED"),
			},
		}},
	}

	for i, record := range cases {
		if _, ok := confirmedFromRecord(record); ok {
			t.Fatalf("case %d: expected skip", i)
		}
	}
}

type fakeEventBridge struct {
	last *eventbridge.PutEventsInput
}

func (f *fakeEventBridge) PutEvents(
	_ context.Context,
	params *eventbridge.PutEventsInput,
	_ ...func(*eventbridge.Options),
) (*eventbridge.PutEventsOutput, error) {
	f.last = params
	return &eventbridge.PutEventsOutput{FailedEntryCount: 0}, nil
}

func TestPublishOrderConfirmed_PutsContractShape(t *testing.T) {
	fake := &fakeEventBridge{}
	now := time.Date(2026, 10, 27, 15, 4, 5, 0, time.UTC)

	err := publishOrderConfirmed(
		context.Background(),
		fake,
		"gatehold-dev",
		"gatehold.orders",
		ConfirmedCandidate{
			OrderID: "ord_1",
			EventID: "evt_001",
			UserID:  "fan-1",
			SeatIDs: []string{"A-12-01"},
		},
		now,
	)
	if err != nil {
		t.Fatal(err)
	}
	if fake.last == nil || len(fake.last.Entries) != 1 {
		t.Fatalf("expected one entry, got %#v", fake.last)
	}
	entry := fake.last.Entries[0]
	if *entry.EventBusName != "gatehold-dev" {
		t.Fatalf("bus: %s", *entry.EventBusName)
	}
	if *entry.Source != "gatehold.orders" {
		t.Fatalf("source: %s", *entry.Source)
	}
	if *entry.DetailType != "OrderConfirmed" {
		t.Fatalf("detail-type: %s", *entry.DetailType)
	}

	var detail OrderConfirmedDetail
	if err := json.Unmarshal([]byte(*entry.Detail), &detail); err != nil {
		t.Fatal(err)
	}
	if detail.OrderID != "ord_1" || detail.EventID != "evt_001" || detail.UserID != "fan-1" {
		t.Fatalf("detail ids: %+v", detail)
	}
	if detail.ConfirmedAt != "2026-10-27T15:04:05.000Z" {
		t.Fatalf("confirmedAt: %s", detail.ConfirmedAt)
	}
	if len(detail.SeatIDs) != 1 || detail.SeatIDs[0] != "A-12-01" {
		t.Fatalf("seatIds: %v", detail.SeatIDs)
	}
}
