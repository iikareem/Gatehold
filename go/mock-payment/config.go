package main

import (
	"os"
	"strconv"
)

// Config holds process settings from the environment.
type Config struct {
	Port             string
	ChaosLatencyMS   int
	ChaosTimeoutRate float64
	Chaos429Rate     float64
	ChaosErrorRate   float64
}

func loadConfig() Config {
	return Config{
		Port:             envOr("PORT", "8090"),
		ChaosLatencyMS:   envInt("CHAOS_LATENCY_MS", 0),
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
