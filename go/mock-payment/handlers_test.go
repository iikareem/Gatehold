package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPAuthorizeThenCapture(t *testing.T) {
	srv := NewServer(Config{Port: "8090"}, NewStore())

	authBody := map[string]any{
		"idempotencyKey": "pay:auth:ord_http_1",
		"orderId":        "ord_http_1",
		"amount":         5000,
		"currency":       "USD",
	}
	authResp := postJSON(t, srv, "/v1/payments/authorize", authBody, http.StatusOK)
	if authResp.Status != StatusAuthorized || authResp.AuthorizationID == "" {
		t.Fatalf("authorize: %+v", authResp)
	}

	capBody := map[string]any{
		"idempotencyKey":  "pay:capture:ord_http_1",
		"orderId":         "ord_http_1",
		"authorizationId": authResp.AuthorizationID,
		"amount":          5000,
		"currency":        "USD",
	}
	capResp := postJSON(t, srv, "/v1/payments/capture", capBody, http.StatusOK)
	if capResp.Status != StatusCaptured {
		t.Fatalf("capture: %+v", capResp)
	}
}

func TestHTTPAuthorizeThenVoid(t *testing.T) {
	srv := NewServer(Config{Port: "8090"}, NewStore())

	authBody := map[string]any{
		"idempotencyKey": "pay:auth:ord_http_2",
		"orderId":        "ord_http_2",
		"amount":         1200,
		"currency":       "USD",
	}
	authResp := postJSON(t, srv, "/v1/payments/authorize", authBody, http.StatusOK)

	voidBody := map[string]any{
		"idempotencyKey":  "pay:void:ord_http_2",
		"orderId":         "ord_http_2",
		"authorizationId": authResp.AuthorizationID,
		"amount":          1200,
		"currency":        "USD",
	}
	voidResp := postJSON(t, srv, "/v1/payments/void", voidBody, http.StatusOK)
	if voidResp.Status != StatusVoided {
		t.Fatalf("void: %+v", voidResp)
	}
}

func postJSON(t *testing.T, h http.Handler, path string, body map[string]any, wantStatus int) PaymentResponse {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != wantStatus {
		t.Fatalf("%s: status %d body %s", path, rec.Code, rec.Body.String())
	}
	var out PaymentResponse
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return out
}
