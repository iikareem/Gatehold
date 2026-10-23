package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestChaos429BeforeAccept(t *testing.T) {
	srv := NewServer(Config{Port: "8090"}, NewStore())

	body := map[string]any{
		"idempotencyKey": "pay:auth:ord_chaos_429",
		"orderId":        "ord_chaos_429",
		"amount":         1000,
		"currency":       "USD",
	}
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/payments/authorize", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Chaos-Force", "429")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("want 429, got %d body %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("expected Retry-After")
	}

	// Never accepted — status must be 404.
	getStatus(t, srv, "pay:auth:ord_chaos_429", http.StatusNotFound)
}

func TestChaosTimeoutAfterSuccessThenStatus(t *testing.T) {
	srv := NewServer(Config{
		Port:           "8090",
		ChaosTimeoutMS: 1, // keep the test fast
	}, NewStore())

	body := map[string]any{
		"idempotencyKey": "pay:auth:ord_chaos_timeout",
		"orderId":        "ord_chaos_timeout",
		"amount":         1000,
		"currency":       "USD",
	}
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/payments/authorize", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Chaos-Force", "timeout")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	// No success body written — client sees an unknown outcome.
	if rec.Body.Len() != 0 {
		t.Fatalf("expected empty body on timeout chaos, got %s", rec.Body.String())
	}

	// Store accepted the auth — status is deterministic.
	got := getStatus(t, srv, "pay:auth:ord_chaos_timeout", http.StatusOK)
	if got.Status != StatusAuthorized || got.AuthorizationID == "" {
		t.Fatalf("status after timeout chaos: %+v", got)
	}
}
