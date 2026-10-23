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

func TestHTTPAuthorizeCaptureRefundAndStatus(t *testing.T) {
	srv := NewServer(Config{Port: "8090"}, NewStore())

	authResp := postJSON(t, srv, "/v1/payments/authorize", map[string]any{
		"idempotencyKey": "pay:auth:ord_http_3",
		"orderId":        "ord_http_3",
		"amount":         2500,
		"currency":       "USD",
	}, http.StatusOK)

	statusAuth := getStatus(t, srv, "pay:auth:ord_http_3", http.StatusOK)
	if statusAuth.Status != StatusAuthorized || statusAuth.AuthorizationID != authResp.AuthorizationID {
		t.Fatalf("status after auth: %+v", statusAuth)
	}

	postJSON(t, srv, "/v1/payments/capture", map[string]any{
		"idempotencyKey":  "pay:capture:ord_http_3",
		"orderId":         "ord_http_3",
		"authorizationId": authResp.AuthorizationID,
		"amount":          2500,
		"currency":        "USD",
	}, http.StatusOK)

	refundResp := postJSON(t, srv, "/v1/payments/refund", map[string]any{
		"idempotencyKey":  "pay:refund:ord_http_3",
		"orderId":         "ord_http_3",
		"authorizationId": authResp.AuthorizationID,
		"amount":          2500,
		"currency":        "USD",
	}, http.StatusOK)
	if refundResp.Status != StatusRefunded {
		t.Fatalf("refund: %+v", refundResp)
	}

	statusCapture := getStatus(t, srv, "pay:capture:ord_http_3", http.StatusOK)
	if statusCapture.Status != StatusRefunded {
		t.Fatalf("status after refund via capture key: %+v", statusCapture)
	}

	getStatus(t, srv, "pay:auth:missing", http.StatusNotFound)
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

func getStatus(t *testing.T, h http.Handler, idempotencyKey string, wantStatus int) PaymentResponse {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/v1/payments/status?idempotencyKey="+idempotencyKey, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != wantStatus {
		t.Fatalf("status %q: got %d body %s", idempotencyKey, rec.Code, rec.Body.String())
	}
	if wantStatus != http.StatusOK {
		return PaymentResponse{}
	}
	var out PaymentResponse
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return out
}
