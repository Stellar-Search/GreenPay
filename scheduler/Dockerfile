# Multi-stage Dockerfile for the GreenPay custom Kubernetes scheduler.
#
# Stage 1 (builder): compiles the Go binary with CGO disabled for a fully
#   static binary that works in a scratch container.
#
# Stage 2 (runner): minimal distroless image — no shell, no package manager,
#   no attack surface.  The binary is the only thing in the image.

# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM golang:1.22-alpine AS builder

WORKDIR /build

# Install build dependencies.
RUN apk add --no-cache git ca-certificates

# Copy source and build.
COPY . .

# Generate go.sum and resolve dependencies for imported packages
RUN go mod tidy

# Build a fully static binary (no libc, no CGO).
# -trimpath removes local file paths from the binary for reproducibility.
# -ldflags "-s -w" strips debug symbols to reduce image size.
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build \
      -trimpath \
      -ldflags="-s -w -extldflags '-static'" \
      -o /greenpay-scheduler \
      ./cmd/scheduler

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM gcr.io/distroless/static-debian12:nonroot AS runner

# Copy the CA bundle so the scheduler can verify TLS to the API server.
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

# Copy the compiled binary.
COPY --from=builder /greenpay-scheduler /greenpay-scheduler

# Run as the nonroot user (uid 65534) provided by distroless:nonroot.
USER nonroot:nonroot

ENTRYPOINT ["/greenpay-scheduler"]
