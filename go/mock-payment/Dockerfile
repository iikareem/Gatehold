# Mock payment provider for local compose (Phase 5+).
# Build context: go/  →  docker compose build mock-payment
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY mock-payment/ ./mock-payment/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/mock-payment ./mock-payment

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=build /out/mock-payment /app/mock-payment
ENV PORT=8090
EXPOSE 8090
ENTRYPOINT ["/app/mock-payment"]
