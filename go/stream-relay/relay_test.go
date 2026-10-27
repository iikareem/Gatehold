package main

import (
	"testing"

	"github.com/aws/aws-lambda-go/events"
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
