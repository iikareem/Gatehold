package main

import (
	"context"
	"fmt"
	"log"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

const (
	ordersEventStatusIndex = "eventId-status"
	defaultPageSize        = int32(100)
)

type dynamoAPI interface {
	Scan(ctx context.Context, params *dynamodb.ScanInput, optFns ...func(*dynamodb.Options)) (*dynamodb.ScanOutput, error)
	Query(ctx context.Context, params *dynamodb.QueryInput, optFns ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error)
	GetItem(ctx context.Context, params *dynamodb.GetItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error)
}

type reconcilerDeps struct {
	dynamo      dynamoAPI
	eventsTable string
	ordersTable string
	seatsTable  string
	pageSize    int32
}

// ReconcileStats counts one detect-only run.
type ReconcileStats struct {
	EventsScanned   int
	OrdersChecked   int
	Inconsistencies int
}

type confirmedOrder struct {
	OrderID string
	EventID string
	SeatIDs []string
}

// findingLogger records one alarmed invariant hit (injectable for tests).
type findingLogger func(orderID, eventID, seatID, seatStatus, reason string)

// Run loads env, builds a Dynamo client, and runs one reconcile pass.
func Run(ctx context.Context) error {
	eventsTable, err := requireEnv("EVENTS_TABLE_NAME")
	if err != nil {
		return err
	}
	ordersTable, err := requireEnv("ORDERS_TABLE_NAME")
	if err != nil {
		return err
	}
	seatsTable, err := requireEnv("SEATS_TABLE_NAME")
	if err != nil {
		return err
	}

	client, err := newDynamoClient(ctx)
	if err != nil {
		return err
	}

	deps := reconcilerDeps{
		dynamo:      client,
		eventsTable: eventsTable,
		ordersTable: ordersTable,
		seatsTable:  seatsTable,
		pageSize:    defaultPageSize,
	}

	stats, err := reconcile(ctx, deps, logFinding)
	if err != nil {
		return err
	}

	emitEMF(stats)

	log.Printf(
		"reconciler done: eventsScanned=%d ordersChecked=%d inconsistencies=%d",
		stats.EventsScanned, stats.OrdersChecked, stats.Inconsistencies,
	)
	return nil
}

func logFinding(orderID, eventID, seatID, seatStatus, reason string) {
	log.Printf(
		`action=alarmed invariant=confirmed-seats-sold orderId=%s eventId=%s seatId=%s seatStatus=%s reason=%s`,
		orderID, eventID, seatID, seatStatus, reason,
	)
}

func reconcile(ctx context.Context, deps reconcilerDeps, logFinding findingLogger) (ReconcileStats, error) {
	var stats ReconcileStats
	if deps.pageSize <= 0 {
		deps.pageSize = defaultPageSize
	}
	if logFinding == nil {
		logFinding = func(string, string, string, string, string) {}
	}

	var eventStart map[string]types.AttributeValue
	for {
		eventIDs, lastKey, err := scanEventPage(ctx, deps, eventStart)
		if err != nil {
			return stats, err
		}
		stats.EventsScanned += len(eventIDs)

		for _, eventID := range eventIDs {
			var orderStart map[string]types.AttributeValue
			for {
				orders, orderLast, err := queryConfirmedPage(ctx, deps, eventID, orderStart)
				if err != nil {
					return stats, err
				}
				for _, order := range orders {
					stats.OrdersChecked++
					n, err := checkOrderSeats(ctx, deps, order, logFinding)
					if err != nil {
						return stats, err
					}
					stats.Inconsistencies += n
				}
				if len(orderLast) == 0 {
					break
				}
				orderStart = orderLast
			}
		}

		if len(lastKey) == 0 {
			break
		}
		eventStart = lastKey
	}

	return stats, nil
}

func scanEventPage(
	ctx context.Context,
	deps reconcilerDeps,
	startKey map[string]types.AttributeValue,
) (eventIDs []string, lastKey map[string]types.AttributeValue, err error) {
	out, err := deps.dynamo.Scan(ctx, &dynamodb.ScanInput{
		TableName:            aws.String(deps.eventsTable),
		ProjectionExpression: aws.String("eventId"),
		ExclusiveStartKey:    startKey,
		Limit:                aws.Int32(deps.pageSize),
	})
	if err != nil {
		return nil, nil, fmt.Errorf("scan events: %w", err)
	}

	eventIDs = make([]string, 0, len(out.Items))
	for _, item := range out.Items {
		if id := attrS(item, "eventId"); id != "" {
			eventIDs = append(eventIDs, id)
		}
	}
	return eventIDs, out.LastEvaluatedKey, nil
}

func queryConfirmedPage(
	ctx context.Context,
	deps reconcilerDeps,
	eventID string,
	startKey map[string]types.AttributeValue,
) (orders []confirmedOrder, lastKey map[string]types.AttributeValue, err error) {
	out, err := deps.dynamo.Query(ctx, &dynamodb.QueryInput{
		TableName:              aws.String(deps.ordersTable),
		IndexName:              aws.String(ordersEventStatusIndex),
		KeyConditionExpression: aws.String("eventId = :eventId AND #status = :confirmed"),
		ExpressionAttributeNames: map[string]string{
			"#status": "status",
		},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":eventId":   &types.AttributeValueMemberS{Value: eventID},
			":confirmed": &types.AttributeValueMemberS{Value: "CONFIRMED"},
		},
		ExclusiveStartKey: startKey,
		Limit:             aws.Int32(deps.pageSize),
	})
	if err != nil {
		return nil, nil, fmt.Errorf("query confirmed orders: %w", err)
	}

	orders = make([]confirmedOrder, 0, len(out.Items))
	for _, item := range out.Items {
		orderID := attrS(item, "orderId")
		if orderID == "" {
			continue
		}
		orders = append(orders, confirmedOrder{
			OrderID: orderID,
			EventID: attrS(item, "eventId"),
			SeatIDs: attrStringList(item, "seatIds"),
		})
	}
	return orders, out.LastEvaluatedKey, nil
}

func checkOrderSeats(
	ctx context.Context,
	deps reconcilerDeps,
	order confirmedOrder,
	logFinding findingLogger,
) (int, error) {
	findings := 0
	eventID := order.EventID
	for _, seatID := range order.SeatIDs {
		seat, err := getSeat(ctx, deps, eventID, seatID)
		if err != nil {
			return findings, err
		}
		ok, reason := seatConsistent(order.OrderID, seat)
		if ok {
			continue
		}
		findings++
		seatStatus := ""
		if seat != nil {
			seatStatus = seat.Status
		} else {
			seatStatus = "MISSING"
		}
		logFinding(order.OrderID, eventID, seatID, seatStatus, reason)
	}
	return findings, nil
}

func getSeat(ctx context.Context, deps reconcilerDeps, eventID, seatID string) (*Seat, error) {
	out, err := deps.dynamo.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(deps.seatsTable),
		Key: map[string]types.AttributeValue{
			"eventId": &types.AttributeValueMemberS{Value: eventID},
			"seatId":  &types.AttributeValueMemberS{Value: seatID},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("get seat %s/%s: %w", eventID, seatID, err)
	}
	if out.Item == nil {
		return nil, nil
	}
	var seat Seat
	if err := attributevalue.UnmarshalMap(out.Item, &seat); err != nil {
		return nil, fmt.Errorf("unmarshal seat %s/%s: %w", eventID, seatID, err)
	}
	return &seat, nil
}

func attrS(item map[string]types.AttributeValue, key string) string {
	v, ok := item[key]
	if !ok {
		return ""
	}
	s, ok := v.(*types.AttributeValueMemberS)
	if !ok {
		return ""
	}
	return s.Value
}

func attrStringList(item map[string]types.AttributeValue, key string) []string {
	v, ok := item[key]
	if !ok {
		return nil
	}
	switch t := v.(type) {
	case *types.AttributeValueMemberL:
		out := make([]string, 0, len(t.Value))
		for _, el := range t.Value {
			if s, ok := el.(*types.AttributeValueMemberS); ok && s.Value != "" {
				out = append(out, s.Value)
			}
		}
		return out
	case *types.AttributeValueMemberSS:
		return append([]string(nil), t.Value...)
	default:
		return nil
	}
}
