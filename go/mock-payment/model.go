package main

// Provider payment statuses (see docs/contracts.md Phase 5).
const (
	StatusAuthorized = "AUTHORIZED"
	StatusCaptured   = "CAPTURED"
	StatusVoided     = "VOIDED"
	StatusRefunded   = "REFUNDED"
	StatusFailed     = "FAILED"
)

// PaymentIntent is the in-memory record for one payment authorization
// and its later capture / void / refund outcome.
// Filled out in later Phase 5 steps; skeleton only.
type PaymentIntent struct {
	IdempotencyKey  string
	OrderID         string
	AuthorizationID string
	PaymentID       string
	Status          string
	Amount          int64
	Currency        string
}

// PaymentResponse is the JSON body returned by payment endpoints.
type PaymentResponse struct {
	IdempotencyKey  string `json:"idempotencyKey"`
	OrderID         string `json:"orderId"`
	AuthorizationID string `json:"authorizationId,omitempty"`
	PaymentID       string `json:"paymentId,omitempty"`
	Status          string `json:"status"`
	Amount          int64  `json:"amount"`
	Currency        string `json:"currency"`
	FailReason      string `json:"failReason,omitempty"`
}

// ErrorBody is the JSON error shape from contracts.md.
type ErrorBody struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}
