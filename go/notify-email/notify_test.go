package main

import (
	"encoding/json"
	"testing"
)

func TestParseOrderConfirmed_SNSEnvelope(t *testing.T) {
	detail := OrderConfirmedDetail{
		OrderID:     "ord_1",
		EventID:     "evt_001",
		UserID:      "alice",
		SeatIDs:     []string{"A-12-01"},
		ConfirmedAt: "2026-10-27T15:04:05.000Z",
	}
	detailJSON, _ := json.Marshal(detail)
	eb, _ := json.Marshal(map[string]any{
		"source":       "gatehold.orders",
		"detail-type":  "OrderConfirmed",
		"detail":       json.RawMessage(detailJSON),
	})
	body, _ := json.Marshal(snsEnvelope{
		Type:    "Notification",
		Message: string(eb),
	})

	got, err := parseOrderConfirmed(string(body))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got.OrderID != "ord_1" || got.UserID != "alice" || len(got.SeatIDs) != 1 {
		t.Fatalf("unexpected detail: %+v", got)
	}
}

func TestNotifyAddress(t *testing.T) {
	t.Setenv("SES_TO_EMAIL", "")
	if got := notifyAddress("alice"); got != "alice@fans.gatehold.local" {
		t.Fatalf("got %q", got)
	}
	t.Setenv("SES_TO_EMAIL", "fixed@example.com")
	if got := notifyAddress("alice"); got != "fixed@example.com" {
		t.Fatalf("override got %q", got)
	}
}
