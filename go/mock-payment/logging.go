package main

import (
	"log/slog"
	"net/http"
	"time"
)

// logResponseWriter captures status and an optional idempotency key for one request log line.
type logResponseWriter struct {
	http.ResponseWriter
	status int
	key    string
}

func (l *logResponseWriter) WriteHeader(code int) {
	if l.status == 0 {
		l.status = code
	}
	l.ResponseWriter.WriteHeader(code)
}

func (l *logResponseWriter) Write(b []byte) (int, error) {
	if l.status == 0 {
		l.status = http.StatusOK
	}
	return l.ResponseWriter.Write(b)
}

func setLogKey(w http.ResponseWriter, key string) {
	if lw, ok := w.(*logResponseWriter); ok {
		lw.key = key
	}
}

func withRequestLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		lw := &logResponseWriter{ResponseWriter: w}
		next.ServeHTTP(lw, r)

		status := lw.status
		key := lw.key
		if key == "" {
			key = r.URL.Query().Get("idempotencyKey")
		}
		slog.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", status,
			"key", key,
			"ms", time.Since(start).Milliseconds(),
		)
	})
}
