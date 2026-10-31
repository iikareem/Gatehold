package main

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

func TestCancellingFromRecord_OnSaleToCancelling(t *testing.T) {
	record := events.DynamoDBEventRecord{
		EventID:   "stream-1",
		EventName: "MODIFY",
		Change: events.DynamoDBStreamRecord{
			OldImage: map[string]events.DynamoDBAttributeValue{
				"status": events.NewStringAttribute("ON_SALE"),
			},
			NewImage: map[string]events.DynamoDBAttributeValue{
				"eventId": events.NewStringAttribute("evt_001"),
				"status":  events.NewStringAttribute("CANCELLING"),
			},
		},
	}

	c, ok := cancellingFromRecord(record)
	if !ok {
		t.Fatal("expected cancelling candidate")
	}
	if c.EventID != "evt_001" || c.StreamID != "stream-1" {
		t.Fatalf("unexpected candidate: %+v", c)
	}
}

func TestCancellingFromRecord_IgnoresNoise(t *testing.T) {
	cases := []events.DynamoDBEventRecord{
		{EventName: "INSERT", Change: events.DynamoDBStreamRecord{
			NewImage: map[string]events.DynamoDBAttributeValue{
				"status": events.NewStringAttribute("CANCELLING"),
			},
		}},
		{EventName: "MODIFY", Change: events.DynamoDBStreamRecord{
			OldImage: map[string]events.DynamoDBAttributeValue{
				"status": events.NewStringAttribute("ON_SALE"),
			},
			NewImage: map[string]events.DynamoDBAttributeValue{
				"status": events.NewStringAttribute("ON_SALE"),
			},
		}},
		{EventName: "MODIFY", Change: events.DynamoDBStreamRecord{
			OldImage: map[string]events.DynamoDBAttributeValue{
				"status": events.NewStringAttribute("CANCELLING"),
			},
			NewImage: map[string]events.DynamoDBAttributeValue{
				"eventId": events.NewStringAttribute("evt_001"),
				"status":  events.NewStringAttribute("CANCELLED"),
			},
		}},
		{EventName: "MODIFY", Change: events.DynamoDBStreamRecord{
			OldImage: map[string]events.DynamoDBAttributeValue{
				"status": events.NewStringAttribute("ON_SALE"),
			},
			NewImage: map[string]events.DynamoDBAttributeValue{
				"status": events.NewStringAttribute("CANCELLING"),
				// missing eventId
			},
		}},
	}

	for i, record := range cases {
		if _, ok := cancellingFromRecord(record); ok {
			t.Fatalf("case %d: expected skip", i)
		}
	}
}

type mockDynamo struct {
	getEvent    map[string]types.AttributeValue
	getBatch    map[string]types.AttributeValue
	putCalls    int
	updateCalls []dynamodb.UpdateItemInput
	queryPages  []dynamodb.QueryOutput
	queryIdx    int
}

func (m *mockDynamo) GetItem(_ context.Context, params *dynamodb.GetItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	table := aws.ToString(params.TableName)
	if table == "events" {
		return &dynamodb.GetItemOutput{Item: m.getEvent}, nil
	}
	return &dynamodb.GetItemOutput{Item: m.getBatch}, nil
}

func (m *mockDynamo) PutItem(_ context.Context, _ *dynamodb.PutItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error) {
	m.putCalls++
	return &dynamodb.PutItemOutput{}, nil
}

func (m *mockDynamo) UpdateItem(_ context.Context, params *dynamodb.UpdateItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	m.updateCalls = append(m.updateCalls, *params)
	return &dynamodb.UpdateItemOutput{}, nil
}

func (m *mockDynamo) Query(_ context.Context, _ *dynamodb.QueryInput, _ ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	if m.queryIdx >= len(m.queryPages) {
		return &dynamodb.QueryOutput{}, nil
	}
	out := m.queryPages[m.queryIdx]
	m.queryIdx++
	return &out, nil
}

type mockSQS struct {
	bodies []string
}

func (m *mockSQS) SendMessageBatch(_ context.Context, params *sqs.SendMessageBatchInput, _ ...func(*sqs.Options)) (*sqs.SendMessageBatchOutput, error) {
	for _, e := range params.Entries {
		m.bodies = append(m.bodies, aws.ToString(e.MessageBody))
	}
	return &sqs.SendMessageBatchOutput{
		Successful: make([]sqstypes.SendMessageBatchResultEntry, len(params.Entries)),
	}, nil
}

func TestFanOutEvent_PagesAndCheckpoints(t *testing.T) {
	lek := map[string]types.AttributeValue{
		"eventId": &types.AttributeValueMemberS{Value: "evt_001"},
		"status":  &types.AttributeValueMemberS{Value: "CONFIRMED"},
		"orderId": &types.AttributeValueMemberS{Value: "ord_1"},
	}

	ddb := &mockDynamo{
		getEvent: map[string]types.AttributeValue{
			"refundBatchId": &types.AttributeValueMemberS{Value: "rb_existing"},
		},
		getBatch: map[string]types.AttributeValue{
			"batchId": &types.AttributeValueMemberS{Value: "rb_existing"},
			"eventId": &types.AttributeValueMemberS{Value: "evt_001"},
			"status":  &types.AttributeValueMemberS{Value: "RUNNING"},
		},
		queryPages: []dynamodb.QueryOutput{
			{
				Items: []map[string]types.AttributeValue{
					{"orderId": &types.AttributeValueMemberS{Value: "ord_1"}},
					{"orderId": &types.AttributeValueMemberS{Value: "ord_2"}},
				},
				LastEvaluatedKey: lek,
			},
			{
				Items: []map[string]types.AttributeValue{
					{"orderId": &types.AttributeValueMemberS{Value: "ord_3"}},
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

	if err := fanOutEvent(context.Background(), deps, "evt_001"); err != nil {
		t.Fatalf("fanOutEvent: %v", err)
	}

	if ddb.putCalls != 0 {
		t.Fatalf("expected no PutItem when batch already attached, got %d", ddb.putCalls)
	}
	if len(sqsMock.bodies) != 3 {
		t.Fatalf("expected 3 SQS messages, got %d", len(sqsMock.bodies))
	}
	var msg RefundQueueMessage
	if err := json.Unmarshal([]byte(sqsMock.bodies[0]), &msg); err != nil {
		t.Fatal(err)
	}
	if msg.OrderID != "ord_1" || msg.EventID != "evt_001" || msg.BatchID != "rb_existing" {
		t.Fatalf("unexpected message: %+v", msg)
	}

	// Two checkpoints: mid-page with LEK, then final fanOutComplete.
	if len(ddb.updateCalls) != 2 {
		t.Fatalf("expected 2 checkpoint updates, got %d", len(ddb.updateCalls))
	}
	first := aws.ToString(ddb.updateCalls[0].UpdateExpression)
	if first != "ADD enqueued :enqueuedDelta SET lastEvaluatedKey = :lek, fanOutComplete = :fanOutComplete" {
		t.Fatalf("first checkpoint expr: %s", first)
	}
	second := aws.ToString(ddb.updateCalls[1].UpdateExpression)
	if second != "ADD enqueued :enqueuedDelta SET fanOutComplete = :fanOutComplete REMOVE lastEvaluatedKey" {
		t.Fatalf("final checkpoint expr: %s", second)
	}
}

func TestFanOutEvent_SkipsWhenFanOutComplete(t *testing.T) {
	ddb := &mockDynamo{
		getEvent: map[string]types.AttributeValue{
			"refundBatchId": &types.AttributeValueMemberS{Value: "rb_done"},
		},
		getBatch: map[string]types.AttributeValue{
			"batchId":        &types.AttributeValueMemberS{Value: "rb_done"},
			"eventId":        &types.AttributeValueMemberS{Value: "evt_001"},
			"status":         &types.AttributeValueMemberS{Value: "RUNNING"},
			"fanOutComplete": &types.AttributeValueMemberBOOL{Value: true},
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

	if err := fanOutEvent(context.Background(), deps, "evt_001"); err != nil {
		t.Fatalf("fanOutEvent: %v", err)
	}
	if len(sqsMock.bodies) != 0 {
		t.Fatalf("expected no enqueue when fanOutComplete, got %d", len(sqsMock.bodies))
	}
	if len(ddb.updateCalls) != 0 {
		t.Fatalf("expected no updates when already complete")
	}
}

func TestEnqueueOrders_ChunksByTen(t *testing.T) {
	sqsMock := &mockSQS{}
	ids := make([]string, 23)
	for i := range ids {
		ids[i] = "ord_" + strconv.Itoa(i)
	}

	err := enqueueOrders(context.Background(), sqsMock, "q", "evt", "rb", ids)
	if err != nil {
		t.Fatal(err)
	}
	if len(sqsMock.bodies) != 23 {
		t.Fatalf("got %d bodies", len(sqsMock.bodies))
	}
}
