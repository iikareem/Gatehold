package main

import (
	"fmt"
	"log"
	"net/http"
)

// Mock payment provider — Phase 5.
// Controllable authorize / capture / void / refund + chaos (built step by step).

func main() {
	cfg := loadConfig()
	store := NewStore()
	srv := NewServer(cfg, store)

	addr := ":" + cfg.Port
	log.Printf("mock-payment listening on http://127.0.0.1%s", addr)
	if err := http.ListenAndServe(addr, srv); err != nil {
		log.Fatal(fmt.Errorf("listen: %w", err))
	}
}
