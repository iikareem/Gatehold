package main

import (
	"context"
	"log"
	"strings"

	"github.com/aws/aws-lambda-go/events"
)

// ConfirmedCandidate is a PENDING→CONFIRMED Orders change (Phase 8a log shape).
type ConfirmedCandidate struct {
	OrderID  string
	EventID  string
	UserID   string
	SeatIDs  []string
	StreamID string // DynamoDB stream eventID (for log correlation)
}

// HandleStream filters MODIFY records and logs OrderConfirmed candidates.
func HandleStream(_ context.Context, event events.DynamoDBEvent) error {
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
