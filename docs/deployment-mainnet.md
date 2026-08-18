# Mainnet Deployment Runbook

This runbook documents the steps required to deploy Stellar GreenPay to Stellar Mainnet, configure backend and frontend environment variables, and register the initial climate projects on-chain.

> This guide is intended for deployers and DevOps engineers preparing the first Mainnet launch.

## 1. Prerequisites

- `Node.js >= 18.x`
- `npm`
- `Rust + Cargo`
- `cargo install --locked stellar-cli`
- A funded Stellar Mainnet account for contract deployment and admin operations
- `freighter` or another Stellar wallet for admin key management
- Access to update `frontend/.env.local` and `backend/.env`

## 2. Build the GreenPay Soroban contract

The GreenPay contract lives in `contracts/greenpay-contract`.

```bash
cd contracts/greenpay-contract
cargo build --target wasm32-unknown-unknown --release
```

Confirm the WASM artifact exists:

```bash
ls -lh target/wasm32-unknown-unknown/release/greenpay_contract.wasm
```

## 3. Deploy the contract to Mainnet

The repository includes `scripts/deploy-contract.sh` to simplify deployment.

```bash
chmod +x scripts/deploy-contract.sh
./scripts/deploy-contract.sh mainnet <identity>
```

- `mainnet` selects Stellar Mainnet.
- `<identity>` is the named Stellar CLI identity configured for your deployer account.

If the deploy succeeds, the script prints:

- `NEXT_PUBLIC_CONTRACT_ID=<contract-id>`
- `CONTRACT_ID=<contract-id>`

### Example

```bash
./scripts/deploy-contract.sh mainnet alice
```

## 4. Configure Mainnet environment variables

Update the frontend and backend environment files with Mainnet endpoints and the deployed contract ID.

### Frontend (`frontend/.env.local`)

```env
NEXT_PUBLIC_STELLAR_NETWORK=mainnet
NEXT_PUBLIC_HORIZON_URL=https://horizon.stellar.org
NEXT_PUBLIC_SOROBAN_RPC_URL=https://soroban.stellar.org
NEXT_PUBLIC_API_URL=https://your-production-api.example.com
NEXT_PUBLIC_CONTRACT_ID=<contract-id>
```

### Backend (`backend/.env`)

```env
PORT=4000
STELLAR_NETWORK=mainnet
HORIZON_URL=https://horizon.stellar.org
SOROBAN_RPC_URL=https://soroban.stellar.org
CONTRACT_ID=<contract-id>
ALLOWED_ORIGINS=https://your-production-app.example.com
```

> `backend/src/services/stellar.js` reads `STELLAR_NETWORK`, `HORIZON_URL`, `SOROBAN_RPC_URL`, and `CONTRACT_ID` from this file.

## 5. Register initial projects on-chain

The smart contract requires an admin call to `register_project(...)` for each verified climate project.

> Note: the existing `scripts/register-project.sh` helper is hard-coded for testnet. For Mainnet, use the direct `stellar contract invoke` flow.

### Register a project

```bash
stellar contract invoke \
  --id <contract-id> \
  --source <admin-identity> \
  --network mainnet \
  -- register_project \
  --admin <admin-public-key> \
  --project_id "project-001" \
  --name "Amazon Reforestation" \
  --wallet <project-wallet-address> \
  --co2_per_xlm 8500
```

- `project_id` should be unique and stable (e.g. `amazon-reforestation`).
- `wallet` is the project’s Stellar destination account.
- `co2_per_xlm` is grams of CO₂ offset per XLM donated.

### Recommended initial registration process

1. Confirm the admin account has enough XLM for fees.
2. Verify the target project wallets are valid Mainnet Stellar addresses.
3. Register one project at a time.
4. Confirm success by querying the project record.

## 6. Verify the deployment

### Check contract deployment

- Confirm the contract ID exists on Stellar Mainnet.
- Inspect contract metadata with Soroban CLI or a Mainnet explorer.

### Check project registration

Call `get_project()` via the contract or through the backend API to ensure the registered project is visible.

### Confirm frontend/backend

- Start the backend with `cd backend && npm run dev`.
- Start the frontend with `cd frontend && npm run dev`.
- Ensure the frontend uses `NEXT_PUBLIC_CONTRACT_ID` and can read project data from the contract.

## 7. Mainnet-specific operations

### Admin identity

Use a dedicated deployer/admin identity for contract initialization and project registration. Keep the secret seed private and secure.

### Production origin

Set `ALLOWED_ORIGINS` in `backend/.env` to your production frontend URL.

### TLS termination (not yet in the k8s manifests)

> **Current state:** the provided `k8s/ingress.yaml` terminates **HTTP only** —
> it has no `tls:` block, no certificate issuer, and the host is the placeholder
> `greenpay.local`. Consequently, every `https://…` URL in the example
> configuration above (`NEXT_PUBLIC_API_URL`, `ALLOWED_ORIGINS`) is a
> **placeholder** until TLS is actually provisioned. Do not point a browser or
> the frontend at those URLs before the steps below are done.

Before exposing the deployment to real users, TLS must be added outside of what
the repository currently ships:

1. Point a real DNS record (e.g. `app.greenpay.example`) at the ingress load
   balancer (`kubectl -n greenpay get svc` → `EXTERNAL-IP` for the nginx
   ingress controller).
2. Install a certificate issuer, e.g. `cert-manager` with a `ClusterIssuer`
   (Let's Encrypt staging first, then prod).
3. Add a `tls:` block to `k8s/ingress.yaml` and switch the host:

   ```yaml
   spec:
     ingressClassName: nginx
     tls:
       - hosts:
           - app.greenpay.example
         secretName: greenpay-tls
     rules:
       - host: app.greenpay.example
         http:
           paths:
             - path: /api
               pathType: Prefix
               backend: { service: { name: backend-svc, port: { number: 4000 } } }
             - path: /
               pathType: Prefix
               backend: { service: { name: frontend-svc, port: { number: 3000 } } }
   ```

4. Verify with `curl -I https://app.greenpay.example/api/health` and a browser
   cert check.

Until step 3 is applied and the certificate is issued, keep the example URLs
below and keep `ALLOWED_ORIGINS` aligned with whatever origin is actually
served (HTTP during staging).

### Network passphrase

Mainnet uses the public passphrase:

```text
Public Global Stellar Network ; September 2015
```

## 8. Troubleshooting

- `stellar: command not found`: install `stellar-cli` with `cargo install --locked stellar-cli`.
- `contract deploy` fails: confirm the identity has enough XLM and the account exists on Mainnet.
- `Contract ID not configured`: ensure `NEXT_PUBLIC_CONTRACT_ID` and `CONTRACT_ID` are set correctly.
- `Soroban RPC` errors: verify `SOROBAN_RPC_URL=https://soroban.stellar.org`.

## 9. Optional follow-up

- Add a deployment manifest with the contract ID and project IDs.
- Update `scripts/register-project.sh` to support Mainnet.
- Add a production-ready frontend origin to `ALLOWED_ORIGINS`.
