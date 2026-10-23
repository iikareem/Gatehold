package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeRequiresJSONContentType(t *testing.T) {
	srv := NewServer(Config{Port: "8090"}, NewStore())
	body := `{"idempotencyKey":"pay:auth:ord_ct","orderId":"ord_ct","amount":100,"currency":"USD"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/payments/authorize", strings.NewReader(body))
	// no Content-Type
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d body %s", rec.Code, rec.Body.String())
	}
}

func TestDecodeRejectsHugeBody(t *testing.T) {
	srv := NewServer(Config{Port: "8090"}, NewStore())
	huge := bytes.Repeat([]byte("a"), maxBodyBytes+10)
	req := httptest.NewRequest(http.MethodPost, "/v1/payments/authorize", bytes.NewReader(huge))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d body %s", rec.Code, rec.Body.String())
	}
}
