package main

import (
	"context"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

func TestIsFanOutStuck(t *testing.T) {
	now := time.Date(2026, 11, 5, 18, 0, 0, 0, time.UTC)
	staleAfter := 5 * time.Minute

	cases := []struct {
		name string
		item map[string]types.AttributeValue
		want bool
	}{
		{
			name: "fresh fan-out",
			item: map[string]types.AttributeValue{
				"status":       &types.AttributeValueMemberS{Value: "RUNNING"},
				"lastFanOutAt": &types.AttributeValueMemberS{Value: "2026-11-05T17:58:00.000Z"},
			},
			want: false,
		},
		{
			name: "stale incomplete fan-out",
			item: map[string]types.AttributeValue{
				"status":         &types.AttributeValueMemberS{Value: "RUNNING"},
				"fanOutComplete": &types.AttributeValueMemberBOOL{Value: false},
				"lastFanOutAt":   &types.AttributeValueMemberS{Value: "2026-11-05T17:50:00.000Z"},
			},
			want: true,
		},
		{
			name: "fan-out complete ignores age",
			item: map[string]types.AttributeValue{
				"status":         &types.AttributeValueMemberS{Value: "RUNNING"},
				"fanOutComplete": &types.AttributeValueMemberBOOL{Value: true},
				"lastFanOutAt":   &types.AttributeValueMemberS{Value: "2026-11-05T17:00:00.000Z"},
			},
			want: false,
		},
		{
			name: "falls back to startedAt",
			item: map[string]types.AttributeValue{
				"status":    &types.AttributeValueMemberS{Value: "RUNNING"},
				"startedAt": &types.AttributeValueMemberS{Value: "2026-11-05T17:40:00.000Z"},
			},
			want: true,
		},
		{
			name: "complete batch ignored",
			item: map[string]types.AttributeValue{
				"status":       &types.AttributeValueMemberS{Value: "COMPLETE"},
				"lastFanOutAt": &types.AttributeValueMemberS{Value: "2026-11-05T17:00:00.000Z"},
			},
			want: false,
		},
		{
			name: "missing timestamps treated stuck",
			item: map[string]types.AttributeValue{
				"status": &types.AttributeValueMemberS{Value: "RUNNING"},
			},
			want: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := isFanOutStuck(tc.item, now, staleAfter)
			if got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

func TestSweepStuckFanOuts_ResumesStaleOnly(t *testing.T) {
	ddb := &mockDynamo{
		getEvent: map[string]types.AttributeValue{
			"refundBatchId": &types.AttributeValueMemberS{Value: "rb_stuck"},
		},
		getBatch: map[string]types.AttributeValue{
			"batchId":        &types.AttributeValueMemberS{Value: "rb_stuck"},
			"eventId":        &types.AttributeValueMemberS{Value: "evt_stuck"},
			"status":         &types.AttributeValueMemberS{Value: "RUNNING"},
			"fanOutComplete": &types.AttributeValueMemberBOOL{Value: false},
		},
		scanPages: []dynamodb.ScanOutput{
			{
				Items: []map[string]types.AttributeValue{
					{
						"batchId":      &types.AttributeValueMemberS{Value: "rb_fresh"},
						"eventId":      &types.AttributeValueMemberS{Value: "evt_fresh"},
						"status":       &types.AttributeValueMemberS{Value: "RUNNING"},
						"lastFanOutAt": &types.AttributeValueMemberS{Value: "2026-11-05T17:58:00.000Z"},
					},
					{
						"batchId":      &types.AttributeValueMemberS{Value: "rb_stuck"},
						"eventId":      &types.AttributeValueMemberS{Value: "evt_stuck"},
						"status":       &types.AttributeValueMemberS{Value: "RUNNING"},
						"lastFanOutAt": &types.AttributeValueMemberS{Value: "2026-11-05T17:50:00.000Z"},
					},
					{
						"batchId":        &types.AttributeValueMemberS{Value: "rb_done_fanout"},
						"eventId":        &types.AttributeValueMemberS{Value: "evt_done"},
						"status":         &types.AttributeValueMemberS{Value: "RUNNING"},
						"fanOutComplete": &types.AttributeValueMemberBOOL{Value: true},
						"lastFanOutAt":   &types.AttributeValueMemberS{Value: "2026-11-05T17:00:00.000Z"},
					},
				},
			},
		},
		queryPages: []dynamodb.QueryOutput{
			{
				Items: []map[string]types.AttributeValue{
					{"orderId": &types.AttributeValueMemberS{Value: "ord_resume"}},
				},
			},
		},
	}
	sqsMock := &mockSQS{}
	deps := orchestratorDeps{
		dynamo:           ddb,
		sqs:              sqsMock,
		eventsTable:      "events",
		ordersTable:      "orders",
		refundBatchesTbl: "refund-batches",
		queueURL:         "https://sqs.example/refunds",
		pageSize:         100,
	}

	now := time.Date(2026, 11, 5, 18, 0, 0, 0, time.UTC)
	if err := sweepStuckFanOuts(context.Background(), deps, now, 5*time.Minute); err != nil {
		t.Fatalf("sweepStuckFanOuts: %v", err)
	}

	if len(sqsMock.bodies) != 1 {
		t.Fatalf("expected only stuck batch to resume, got %d messages", len(sqsMock.bodies))
	}
	if len(ddb.updateCalls) != 1 {
		t.Fatalf("expected 1 checkpoint from resume, got %d", len(ddb.updateCalls))
	}
}
