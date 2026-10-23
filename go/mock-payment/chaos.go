package main

import (
	"math/rand/v2"
	"net/http"
	"time"
)

// X-Chaos-Force overrides env rates for one request (deterministic smoke/tests).
// Values: 429 | 500 | 502 | timeout | latency
const chaosForceHeader = "X-Chaos-Force"

// Chaos injects flaky transport behavior without changing payment rules.
//
// Before (fail before accept): 429 / 5xx — store is not called.
// After (timeout after success): store already ran; response may be delayed or dropped.
type Chaos struct {
	cfg Config
}

func NewChaos(cfg Config) *Chaos {
	return &Chaos{cfg: cfg}
}

// Before runs at the start of a handler.
// Returns true if the response was already written (caller should return).
func (c *Chaos) Before(w http.ResponseWriter, r *http.Request) bool {
	force := r.Header.Get(chaosForceHeader)
	switch force {
	case "429":
		writeChaos429(w)
		return true
	case "500":
		writeError(w, http.StatusInternalServerError, "CHAOS_ERROR", "injected 500")
		return true
	case "502":
		writeError(w, http.StatusBadGateway, "CHAOS_ERROR", "injected 502")
		return true
	case "timeout", "latency":
		// Applied in After (after business logic / store write).
		return false
	}

	if roll(c.cfg.Chaos429Rate) {
		writeChaos429(w)
		return true
	}
	if roll(c.cfg.ChaosErrorRate) {
		if rand.Float64() < 0.5 {
			writeError(w, http.StatusInternalServerError, "CHAOS_ERROR", "injected 500")
		} else {
			writeError(w, http.StatusBadGateway, "CHAOS_ERROR", "injected 502")
		}
		return true
	}
	return false
}

// After runs after a successful store result is ready, before writing it.
// Returns true if the caller must NOT write the success body
// (timeout-after-success: outcome is already stored — client should GET /status).
func (c *Chaos) After(w http.ResponseWriter, r *http.Request) bool {
	_ = w
	force := r.Header.Get(chaosForceHeader)

	latencyMS := c.cfg.ChaosLatencyMS
	if force == "latency" && latencyMS == 0 {
		latencyMS = 200
	}
	if latencyMS > 0 {
		time.Sleep(time.Duration(latencyMS) * time.Millisecond)
	}

	if force == "timeout" || roll(c.cfg.ChaosTimeoutRate) {
		ms := c.cfg.ChaosTimeoutMS
		if ms <= 0 {
			ms = 30_000
		}
		time.Sleep(time.Duration(ms) * time.Millisecond)
		// Drop the success body so the client experiences an unknown outcome.
		return true
	}
	return false
}

func writeChaos429(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "1")
	writeError(w, http.StatusTooManyRequests, "RATE_LIMITED", "chaos rate limit")
}

func roll(rate float64) bool {
	if rate <= 0 {
		return false
	}
	if rate >= 1 {
		return true
	}
	return rand.Float64() < rate
}
