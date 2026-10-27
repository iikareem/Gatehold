package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
)

// ConfirmedCandidate is a PENDING→CONFIRMED Orders change.
type ConfirmedCandidate struct {
	OrderID  string
	EventID  string
	UserID   string
	SeatIDs  []string
	StreamID string // DynamoDB stream eventID (for log correlation)
}

// HandleStream filters MODIFY records and publishes OrderConfirmed to EventBridge.
func HandleStream(ctx context.Context, event events.DynamoDBEvent) error {
	busName := os.Getenv("EVENT_BUS_NAME")
	source := os.Getenv("EVENT_SOURCE")
	if source == "" {
		source = defaultEventSource
	}

	client, err := newEventBridgeClient(ctx)
	if err != nil {
		return err
	}

	now := time.Now().UTC()
	for _, record := range event.Records {
		c, ok := confirmedFromRecord(record)
		if !ok {
			continue
		}

		log.Printf(
			"OrderConfirmed candidate orderId=%s eventId=%s userId=%s seatIds=%s streamEventId=%s",
			c.OrderID,
			c.EventID,
			c.UserID,
			strings.Join(c.SeatIDs, ","),
			c.StreamID,
		)

		if err := publishOrderConfirmed(ctx, client, busName, source, c, now); err != nil {
			return fmt.Errorf("orderId=%s: %w", c.OrderID, err)
		}

		log.Printf(
			"OrderConfirmed published orderId=%s bus=%s source=%s",
			c.OrderID,
			busName,
			source,
		)
	}
	return nil
}

func confirmedFromRecord(record events.DynamoDBEventRecord) (ConfirmedCandidate, bool) {
	if record.EventName != "MODIFY" {
		return ConfirmedCandidate{}, false
	}

	oldStatus := attrString(record.Change.OldImage, "status")
	newStatus := attrString(record.Change.NewImage, "status")
	if oldStatus != "PENDING" || newStatus != "CONFIRMED" {
		return ConfirmedCandidate{}, false
	}

	img := record.Change.NewImage
	return ConfirmedCandidate{
		OrderID:  attrString(img, "orderId"),
		EventID:  attrString(img, "eventId"),
		UserID:   attrString(img, "userId"),
		SeatIDs:  attrStringList(img, "seatIds"),
		StreamID: record.EventID,
	}, true
}

func attrString(img map[string]events.DynamoDBAttributeValue, key string) string {
	v, ok := img[key]
	if !ok || v.DataType() != events.DataTypeString {
		return ""
	}
	return v.String()
}

func attrStringList(img map[string]events.DynamoDBAttributeValue, key string) []string {
	v, ok := img[key]
	if !ok {
		return nil
	}
	switch v.DataType() {
	case events.DataTypeList:
		list := v.List()
		out := make([]string, 0, len(list))
		for _, item := range list {
			if item.DataType() == events.DataTypeString {
				out = append(out, item.String())
			}
		}
		return out
	case events.DataTypeStringSet:
		return append([]string(nil), v.StringSet()...)
	default:
		return nil
	}
}
