package main

// Seat is the seats-table shape needed for confirmed-seats-sold checks.
// A nil *Seat means the row was missing from DynamoDB.
type Seat struct {
	EventID string `dynamodbav:"eventId"`
	SeatID  string `dynamodbav:"seatId"`
	Status  string `dynamodbav:"status"`
	OrderID string `dynamodbav:"orderId"`
}

// seatConsistent reports whether a seat row matches a CONFIRMED order
// (invariant confirmed-seats-sold). Returns ok=false and a short reason on failure.
func seatConsistent(orderID string, seat *Seat) (ok bool, reason string) {
	if orderID == "" {
		return false, "missing_order_id"
	}
	if seat == nil {
		return false, "seat_missing"
	}
	if seat.Status != "SOLD" {
		return false, "seat_not_sold"
	}
	if seat.OrderID == "" {
		return false, "sold_missing_order_id"
	}
	if seat.OrderID != orderID {
		return false, "sold_wrong_order_id"
	}
	return true, ""
}
