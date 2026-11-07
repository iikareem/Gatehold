package main

import "testing"

func TestSeatConsistent(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		orderID  string
		seat     *Seat
		wantOK   bool
		wantReason string
	}{
		{
			name:       "missing_order_id",
			orderID:    "",
			seat:       &Seat{Status: "SOLD", OrderID: "ord_1"},
			wantOK:     false,
			wantReason: "missing_order_id",
		},
		{
			name:       "seat_missing",
			orderID:    "ord_1",
			seat:       nil,
			wantOK:     false,
			wantReason: "seat_missing",
		},
		{
			name:       "available",
			orderID:    "ord_1",
			seat:       &Seat{Status: "AVAILABLE"},
			wantOK:     false,
			wantReason: "seat_not_sold",
		},
		{
			name:       "held",
			orderID:    "ord_1",
			seat:       &Seat{Status: "HELD", OrderID: "ord_1"},
			wantOK:     false,
			wantReason: "seat_not_sold",
		},
		{
			name:       "paying",
			orderID:    "ord_1",
			seat:       &Seat{Status: "PAYING", OrderID: "ord_1"},
			wantOK:     false,
			wantReason: "seat_not_sold",
		},
		{
			name:       "sold_missing_order_id",
			orderID:    "ord_1",
			seat:       &Seat{Status: "SOLD"},
			wantOK:     false,
			wantReason: "sold_missing_order_id",
		},
		{
			name:       "sold_wrong_order_id",
			orderID:    "ord_1",
			seat:       &Seat{Status: "SOLD", OrderID: "ord_other"},
			wantOK:     false,
			wantReason: "sold_wrong_order_id",
		},
		{
			name:     "sold_matching",
			orderID:  "ord_1",
			seat:     &Seat{EventID: "evt_001", SeatID: "A-12-01", Status: "SOLD", OrderID: "ord_1"},
			wantOK:   true,
			wantReason: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			ok, reason := seatConsistent(tc.orderID, tc.seat)
			if ok != tc.wantOK || reason != tc.wantReason {
				t.Fatalf("seatConsistent(%q, %+v) = (%v, %q); want (%v, %q)",
					tc.orderID, tc.seat, ok, reason, tc.wantOK, tc.wantReason)
			}
		})
	}
}
