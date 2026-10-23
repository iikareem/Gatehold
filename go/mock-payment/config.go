package main

import (
	"os"
	"strconv"
)

// Config holds process settings from the environment.
type Config struct {
	Port string

	// Chaos knobs (see docs/contracts.md Phase 5).
	ChaosLatencyMS   int     // sleep before successful response (0 = off)
	ChaosTimeoutMS   int     // sleep when simulating timeout (default 30s)
	ChaosTimeoutRate float64 // probability of timeout-after-success
	Chaos429Rate     float64 // probability of 429 before accept
	ChaosErrorRate   float64 // probability of 5xx before accept
}

func loadConfig() Config {
	return Config{
		Port:             envOr("PORT", "8090"),
		ChaosLatencyMS:   envInt("CHAOS_LATENCY_MS", 0),
		ChaosTimeoutMS:   envInt("CHAOS_TIMEOUT_MS", 30_000),
		ChaosTimeoutRate: envFloat("CHAOS_TIMEOUT_RATE", 0),
		Chaos429Rate:     envFloat("CHAOS_429_RATE", 0),
		ChaosErrorRate:   envFloat("CHAOS_ERROR_RATE", 0),
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}

func envFloat(key string, fallback float64) float64 {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return fallback
	}
	return n
}
