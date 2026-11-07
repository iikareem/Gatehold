package main

import (
	"context"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

type mockDynamo struct {
	scanOut  *dynamodb.ScanOutput
	queryOut *dynamodb.QueryOutput
	getOut   *dynamodb.GetItemOutput
	getCalls int
}

func (m *mockDynamo) Scan(ctx context.Context, params *dynamodb.ScanInput, optFns ...func(*dynamodb.Options)) (*dynamodb.ScanOutput, error) {
	if m.scanOut == nil {
		return &dynamodb.ScanOutput{}, nil
	}
	return m.scanOut, nil
}

func (m *mockDynamo) Query(ctx context.Context, params *dynamodb.QueryInput, optFns ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	if m.queryOut == nil {
		return &dynamodb.QueryOutput{}, nil
	}
	return m.queryOut, nil
}

func (m *mockDynamo) GetItem(ctx context.Context, params *dynamodb.GetItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	m.getCalls++
	if m.getOut == nil {
		return &dynamodb.GetItemOutput{}, nil
	}
	return m.getOut, nil
}

func TestReconcile_FindsConfirmedSeatNotSold(t *testing.T) {
	t.Parallel()

	dyn := &mockDynamo{
		scanOut: &dynamodb.ScanOutput{
			Items: []map[string]types.AttributeValue{
				{"eventId": &types.AttributeValueMemberS{Value: "evt_001"}},
			},
		},
		queryOut: &dynamodb.QueryOutput{
			Items: []map[string]types.AttributeValue{
				{
					"orderId": &types.AttributeValueMemberS{Value: "ord_1"},
					"eventId": &types.AttributeValueMemberS{Value: "evt_001"},
					"seatIds": &types.AttributeValueMemberL{Value: []types.AttributeValue{
						&types.AttributeValueMemberS{Value: "A-12-01"},
					}},
					"status": &types.AttributeValueMemberS{Value: "CONFIRMED"},
				},
			},
		},
		getOut: &dynamodb.GetItemOutput{
			Item: map[string]types.AttributeValue{
				"eventId": &types.AttributeValueMemberS{Value: "evt_001"},
				"seatId":  &types.AttributeValueMemberS{Value: "A-12-01"},
				"status":  &types.AttributeValueMemberS{Value: "PAYING"},
				"orderId": &types.AttributeValueMemberS{Value: "ord_1"},
			},
		},
	}

	var findings []string
	stats, err := reconcile(context.Background(), reconcilerDeps{
		dynamo:      dyn,
		eventsTable: "events",
		ordersTable: "orders",
		seatsTable:  "seats",
		pageSize:    100,
	}, func(orderID, eventID, seatID, seatStatus, reason string) {
		findings = append(findings, orderID+"|"+seatID+"|"+seatStatus+"|"+reason)
	})
	if err != nil {
		t.Fatal(err)
	}
	if stats.EventsScanned != 1 || stats.OrdersChecked != 1 || stats.Inconsistencies != 1 {
		t.Fatalf("stats = %+v", stats)
	}
	if len(findings) != 1 || findings[0] != "ord_1|A-12-01|PAYING|seat_not_sold" {
		t.Fatalf("findings = %v", findings)
	}
	if dyn.getCalls != 1 {
		t.Fatalf("getCalls = %d", dyn.getCalls)
	}
}

func TestReconcile_ConsistentSoldSeat(t *testing.T) {
	t.Parallel()

	dyn := &mockDynamo{
		scanOut: &dynamodb.ScanOutput{
			Items: []map[string]types.AttributeValue{
				{"eventId": &types.AttributeValueMemberS{Value: "evt_001"}},
			},
		},
		queryOut: &dynamodb.QueryOutput{
			Items: []map[string]types.AttributeValue{
				{
					"orderId": &types.AttributeValueMemberS{Value: "ord_1"},
					"eventId": &types.AttributeValueMemberS{Value: "evt_001"},
					"seatIds": &types.AttributeValueMemberL{Value: []types.AttributeValue{
						&types.AttributeValueMemberS{Value: "A-12-01"},
					}},
				},
			},
		},
		getOut: &dynamodb.GetItemOutput{
			Item: map[string]types.AttributeValue{
				"eventId": &types.AttributeValueMemberS{Value: "evt_001"},
				"seatId":  &types.AttributeValueMemberS{Value: "A-12-01"},
				"status":  &types.AttributeValueMemberS{Value: "SOLD"},
				"orderId": &types.AttributeValueMemberS{Value: "ord_1"},
			},
		},
	}

	stats, err := reconcile(context.Background(), reconcilerDeps{
		dynamo:      dyn,
		eventsTable: "events",
		ordersTable: "orders",
		seatsTable:  "seats",
	}, func(string, string, string, string, string) {
		t.Fatal("unexpected finding")
	})
	if err != nil {
		t.Fatal(err)
	}
	if stats.Inconsistencies != 0 || stats.OrdersChecked != 1 {
		t.Fatalf("stats = %+v", stats)
	}
}

func TestReconcile_MissingSeat(t *testing.T) {
	t.Parallel()

	dyn := &mockDynamo{
		scanOut: &dynamodb.ScanOutput{
			Items: []map[string]types.AttributeValue{
				{"eventId": &types.AttributeValueMemberS{Value: "evt_001"}},
			},
		},
		queryOut: &dynamodb.QueryOutput{
			Items: []map[string]types.AttributeValue{
				{
					"orderId": &types.AttributeValueMemberS{Value: "ord_1"},
					"eventId": &types.AttributeValueMemberS{Value: "evt_001"},
					"seatIds": &types.AttributeValueMemberL{Value: []types.AttributeValue{
						&types.AttributeValueMemberS{Value: "A-12-99"},
					}},
				},
			},
		},
		getOut: &dynamodb.GetItemOutput{}, // nil Item
	}

	var reason string
	stats, err := reconcile(context.Background(), reconcilerDeps{
		dynamo:      dyn,
		eventsTable: "events",
		ordersTable: "orders",
		seatsTable:  "seats",
	}, func(_, _, _, _, r string) {
		reason = r
	})
	if err != nil {
		t.Fatal(err)
	}
	if stats.Inconsistencies != 1 || reason != "seat_missing" {
		t.Fatalf("stats=%+v reason=%q", stats, reason)
	}
}

func TestAttrStringList(t *testing.T) {
	t.Parallel()
	item := map[string]types.AttributeValue{
		"seatIds": &types.AttributeValueMemberL{Value: []types.AttributeValue{
			&types.AttributeValueMemberS{Value: "A-12-01"},
			&types.AttributeValueMemberS{Value: "A-12-02"},
		}},
	}
	got := attrStringList(item, "seatIds")
	if len(got) != 2 || got[0] != "A-12-01" || got[1] != "A-12-02" {
		t.Fatalf("got %v", got)
	}
}
