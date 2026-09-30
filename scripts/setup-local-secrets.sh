#!/usr/bin/env bash

# scripts/setup-local-secrets.sh
#
# Local development secret setup script.
# Enables running GreenPay locally without requiring the External Secrets Operator.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "================================================="
echo " GreenPay Local Secrets Bootstrap (Non-ESO Path)"
echo "================================================="

# Step 1: Create local backend .env if missing
BACKEND_ENV="$PROJECT_ROOT/backend/.env"
if [ ! -f "$BACKEND_ENV" ]; then
  echo "[1/2] Creating local backend/.env with safe dev defaults..."
  cat <<'EOF' > "$BACKEND_ENV"
NODE_ENV=development
PORT=4000
DATABASE_URL=postgres://postgres:postgres@localhost:5432/greenpay
JWT_SECRET=dev_jwt_secret_must_be_at_least_32_chars_long_for_security!
ADMIN_USERNAME=admin
ADMIN_PASSWORD=dev_admin_password_123!
STELLAR_NETWORK=testnet
CREDENTIAL_MAX_AGE_DAYS=90
EOF
  echo "✅ Created $BACKEND_ENV"
else
  echo "ℹ️ $BACKEND_ENV already exists. Skipping file creation."
fi

# Step 2: Create local Kubernetes Secret if kubectl is available
if command -v kubectl &> /dev/null; then
  echo "[2/2] Bootstrapping local Kubernetes secret 'greenpay-secrets'..."
  if kubectl cluster-info &> /dev/null; then
    kubectl create namespace greenpay --dry-run=client -o yaml | kubectl apply --validate=false -f -
    
    kubectl create secret generic greenpay-secrets \
      --namespace greenpay \
      --from-literal=POSTGRES_USER="postgres" \
      --from-literal=POSTGRES_PASSWORD="postgres" \
      --from-literal=POSTGRES_DB="greenpay" \
      --from-literal=DATABASE_URL="postgres://postgres:postgres@postgres-svc:5432/greenpay" \
      --from-literal=RESEND_API_KEY="" \
      --from-literal=ADMIN_API_KEY="dev_admin_api_key_32_characters_long_min!" \
      --from-literal=AWS_ACCESS_KEY_ID="" \
      --from-literal=AWS_SECRET_ACCESS_KEY="" \
      --dry-run=client -o yaml | kubectl apply --validate=false -f -
    echo "✅ Kubernetes secret 'greenpay-secrets' applied successfully."
  else
    echo "ℹ️ Kubernetes cluster not reachable. Skipping live cluster secret apply."
  fi
else
  echo "ℹ️ kubectl not found. Skipping Kubernetes secret creation."
fi

echo "-------------------------------------------------"
echo "🎉 Local secret setup complete!"
echo "For local Helm deployment without ESO, deploy using:"
echo "  helm upgrade --install greenpay helm/greenpay --set secrets.provider=inline --set secrets.postgresPassword=postgres"
echo "-------------------------------------------------"
