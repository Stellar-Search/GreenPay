# Build Stage
FROM golang:1.25-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache git ca-certificates

# 1. Separate cached layer for dependencies
COPY go.mod go.sum ./
RUN go mod download

# 2. Copy source code after dependencies are cached
COPY . .

# 3. Build binary using -mod=readonly to prevent silent lockfile mutations
RUN CGO_ENABLED=0 GOOS=linux go build -mod=readonly -a -installsuffix cgo -o scheduler ./cmd/scheduler

# Final Runtime Stage (non-root UID 65534 - nobody)
FROM gcr.io/distroless/static-debian12:nonroot

WORKDIR /

# Copy compiled binary from builder
COPY --from=builder /app/scheduler /scheduler

# 4. Consistent UID across Dockerfile comment, Dockerfile USER, and k8s runAsUser (65534)
# 65534 is nobody:nobody in distroless
USER 65534:65534

ENTRYPOINT ["/scheduler"]
