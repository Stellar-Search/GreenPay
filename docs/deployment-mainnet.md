# Mainnet Deployment Runbook

This runbook documents the steps required to deploy Stellar GreenPay to Stellar Mainnet: deploying the contract, configuring the cluster, and registering the initial climate projects on-chain.

> This guide is intended for deployers and DevOps engineers preparing the first Mainnet launch.

## 0. One source of truth for deployed configuration

**The Helm chart is the only supported way to configure a deployed GreenPay environment.** Network selection, Horizon and Soroban RPC endpoints, the contract id and the public hostname all come from the chart's values files, and nothing else:

| File | Role |
| --- | --- |
| `helm/greenpay/values.yaml` | Base defaults. Testnet, `greenpay.local`, empty inline passwords. Safe by default; never deploy Mainnet with this file alone. |
| `helm/greenpay/values-mainnet.yaml` | Mainnet overlay. Overrides only the fields that differ: network, Horizon/Soroban URLs, USDC issuer, ingress host and TLS, and `secrets.provider: external`. Contains no credentials. |
| `helm/greenpay/ci/mainnet-render-check.yaml` | CI-only stand-ins for the deploy-time values the overlay leaves empty. Never used for a real deploy. |

Two things that are **not** deployment configuration:

- `backend/.env` and `frontend/.env.local` configure a developer's local machine (`npm run dev`). They are not read by anything running in the cluster — the pods read the ConfigMap and Secret the chart renders. Editing them has no effect on a deployed environment.
- `k8s/*.yaml` are hardcoded testnet manifests used for local/dev clusters. They are not parameterised per environment and must not be applied to a Mainnet cluster.

Because the merged values are the only input, the pre-deploy guard (§4) can check the *rendered* release and reject a Mainnet deploy that still carries testnet settings.

## 1. Prerequisites

- `Node.js >= 18.x`
- `npm`
- `Rust + Cargo`
- `cargo install --locked stellar-cli`
- `helm` 3.x and `kubectl`, with your context pointed at the production cluster
- [External Secrets Operator](https://external-secrets.io/latest/introduction/getting-started/) installed in that cluster (the chart renders a `SecretStore` + `ExternalSecret`; it does not install ESO itself)
- An AWS Secrets Manager secret (or Vault path) whose JSON keys match the workload Secret listed in §4.1
- A funded Stellar Mainnet account for contract deployment and admin operations
- `freighter` or another Stellar wallet for admin key management

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

Keep the contract id — step 4 passes it to Helm.

## 4. Deploy to Mainnet with Helm

### 4.1 Provision production credentials

The Mainnet overlay sets `secrets.provider: external`, so the chart renders **no** inline Secret and no production credential is ever written into a values file. External Secrets Operator reads a JSON blob from AWS Secrets Manager (default) or Vault and materializes `Secret/greenpay-secrets` in the `greenpay` namespace.

1. **Install External Secrets Operator** if it is not already in the cluster (once per cluster):

   ```bash
   helm repo add external-secrets https://charts.external-secrets.io
   helm upgrade --install external-secrets external-secrets/external-secrets \
     -n external-secrets --create-namespace
   ```

   Give the operator permission to read the backend (IRSA / instance role on AWS, or a Kubernetes auth role on Vault). The chart's `SecretStore` uses the operator's own credentials; it does not embed access keys.

   Create the application namespace before the first helm upgrade so the `SecretStore` / `ExternalSecret` have a home:

   ```bash
   kubectl create namespace greenpay --dry-run=client -o yaml | kubectl apply -f -
   ```

2. **Create the remote secret.** JSON keys must match what the workloads mount:

   ```text
   POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB, DATABASE_URL,
   RESEND_API_KEY, ADMIN_API_KEY
   ```

   `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are optional (Postgres WAL archiving).

   AWS Secrets Manager example:

   ```bash
   aws secretsmanager create-secret \
     --name greenpay/mainnet \
     --secret-string "$(jq -n \
       --arg user greenpay \
       --arg pw "$(openssl rand -base64 32)" \
       --arg db greenpay \
       --arg resend '<resend key>' \
       --arg admin "$(openssl rand -hex 32)" \
       '{
          POSTGRES_USER: $user,
          POSTGRES_PASSWORD: $pw,
          POSTGRES_DB: $db,
          DATABASE_URL: ("postgres://" + $user + ":" + $pw + "@postgres-svc:5432/" + $db),
          RESEND_API_KEY: $resend,
          ADMIN_API_KEY: $admin
        }')"
   ```

   Vault KV-v2: write the same keys at `secret/data/greenpay/mainnet` and deploy with `--set secrets.external.backend=vault --set secrets.external.vault.server=https://vault.example --set secrets.external.remoteKey=greenpay/mainnet`.

3. **Helm then wires it.** `helm/greenpay/templates/external-secret.yaml` renders a namespaced `SecretStore` (AWS Secrets Manager in `us-east-1` by default) and an `ExternalSecret` that extracts `greenpay/mainnet` into `greenpay-secrets`. Override at deploy time with `--set secrets.external.remoteKey=...` and `--set secrets.external.aws.region=...`.

If the cluster already has a `SecretStore` / `ClusterSecretStore`, deploy with `--set secrets.external.createSecretStore=false --set secrets.external.secretStoreName=<existing> --set secrets.external.secretStoreKind=ClusterSecretStore`.

`secrets.provider: inline` is for local clusters only, and even then the password is empty in git — pass it with `--set secrets.postgresPassword=...`. The pre-deploy guard refuses a Mainnet release that still renders an inline Secret with an empty, short, or known-default password.

As a last-resort fallback (no ESO), `--set secrets.provider=inline --set secrets.existingSecret=greenpay-secrets-mainnet` mounts a Secret you create out-of-band with `kubectl create secret generic`. That path is unsupported for Mainnet; the overlay does not use it.

### 4.2 Run the pre-deploy guard

`scripts/validate-helm-release.js` renders the merged values with `helm template` and asserts the invariants on the rendered output — not on any single values file, because a bad merge or a stray `--set` is exactly what it exists to catch. It refuses the deploy when:

- `stellarNetwork: mainnet` is combined with a testnet Horizon or Soroban RPC URL (and the reverse: a testnet release pointed at a pubnet endpoint),
- the contract id is empty or malformed, or the backend and frontend disagree on network, endpoints or contract id,
- the rendered Secret still carries an empty, known-default, or short password, or an empty admin key (inline provider only; the overlay uses External Secrets and renders no Secret),
- the ingress host is still `greenpay.local`, a `.local`/reserved placeholder domain, or empty, or TLS is off while origins are `https`,
- the release renders a different network from the one the deploy expects (`--expect-network`).

Run it with the exact arguments you are about to deploy with:

```bash
node scripts/validate-helm-release.js \
  -f helm/greenpay/values.yaml \
  -f helm/greenpay/values-mainnet.yaml \
  --set config.contractId=<contract-id> \
  --set ingress.host=app.greenpay.example \
  --set config.emailFrom="GreenPay <updates@greenpay.example>" \
  --set certManager.acme.email=ops@greenpay.example \
  --expect-network mainnet
```

A clean run prints `✔ Rendered release is consistent for network=mainnet`. Anything else exits non-zero and lists what is wrong — do not deploy until it is clean. The same check runs in CI (`Helm Release Guard`) on every pull request.

### 4.3 Deploy

```bash
helm upgrade --install greenpay helm/greenpay \
  -f helm/greenpay/values.yaml \
  -f helm/greenpay/values-mainnet.yaml \
  --set config.contractId=<contract-id> \
  --set ingress.host=app.greenpay.example \
  --set config.emailFrom="GreenPay <updates@greenpay.example>" \
  --set certManager.acme.email=ops@greenpay.example \
  --namespace greenpay
```

Values supplied at deploy time — the overlay deliberately leaves them empty so a Mainnet release can never inherit a testnet or placeholder value:

| Value | Source |
| --- | --- |
| `config.contractId` | printed by `scripts/deploy-contract.sh mainnet` (step 3) |
| `ingress.host` | the production hostname (§7) |
| `config.emailFrom` | the production transactional sender address |
| `certManager.acme.email` | Let's Encrypt account contact; required for the ClusterIssuer the overlay renders |

### 4.4 Verify what the cluster actually received

The guard also validates a live release, so you can confirm the running configuration rather than the intended one:

```bash
helm get manifest greenpay -n greenpay | node scripts/validate-helm-release.js --manifest -
```

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
- `wallet` is the project's Stellar destination account.
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

### Check the rendered configuration

```bash
kubectl -n greenpay get configmap greenpay-config -o yaml
```

`STELLAR_NETWORK`, `HORIZON_URL`, `SOROBAN_RPC_URL`, `CONTRACT_ID` and their `NEXT_PUBLIC_*` counterparts must all be the Mainnet values. `SOROBAN_RPC_URL` in particular must be present: `backend/src/services/stellar.js` falls back to the **testnet** RPC when it is unset, which is why the chart always renders it and the guard fails when it is missing.

### Check the running pods

```bash
kubectl -n greenpay rollout status deploy/backend deploy/frontend
kubectl -n greenpay exec deploy/backend -- printenv STELLAR_NETWORK HORIZON_URL SOROBAN_RPC_URL CONTRACT_ID
curl -s https://app.greenpay.example/api/health
```

`/api/health` reports the network the backend actually resolved — confirm it says `mainnet`.

### Check project registration

Call `get_project()` via the contract or through the backend API to ensure the registered project is visible.

## 7. Mainnet-specific operations

### Admin identity

Use a dedicated deployer/admin identity for contract initialization and project registration. Keep the secret seed private and secure.

### TLS and DNS

The Mainnet overlay turns TLS on and wires cert-manager so the certificate is issued, not assumed:

| Value | Overlay default | What it does |
| --- | --- | --- |
| `ingress.tls.enabled` | `true` | Renders `spec.tls` on every Ingress (combined + canary pair) |
| `ingress.tls.secretName` | `greenpay-tls` | Secret cert-manager writes the leaf cert into |
| `ingress.tls.clusterIssuer` | `letsencrypt-prod` | Sets the `cert-manager.io/cluster-issuer` annotation |
| `certManager.enabled` | `true` | Renders `helm/greenpay/templates/cluster-issuer.yaml` |
| `certManager.clusterIssuerName` | `letsencrypt-prod` | Must match `ingress.tls.clusterIssuer` |
| `certManager.acme.email` | empty | Let's Encrypt account contact — set at deploy time |
| `certManager.acme.server` | `https://acme-v02.api.letsencrypt.org/directory` | Production ACME. Use the staging directory first (below). |

`k8s/ingress.yaml` is the local/dev manifest (`greenpay.local` + a `tls` block pointing at `greenpay-tls`). It is not applied to Mainnet; populate that Secret with mkcert or a self-signed cert if you need HTTPS on a local cluster.

#### Provision the certificate

1. **Install cert-manager** in the cluster if it is not already there (once per cluster, not per release):

   ```bash
   # Current release: https://cert-manager.io/docs/installation/
   kubectl apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml
   kubectl -n cert-manager rollout status deploy/cert-manager deploy/cert-manager-webhook
   ```

2. **Point DNS** at the ingress load balancer. Wait until the hostname you will pass as `ingress.host` resolves to that address:

   ```bash
   kubectl -n ingress-nginx get svc ingress-nginx-controller -o wide
   ```

3. **Issue from staging first.** Let's Encrypt production has tight rate limits; a first cutover should use the staging ACME directory so a mis-pointed DNS record does not burn the quota. Deploy as in §4.3 plus:

   ```bash
   --set certManager.clusterIssuerName=letsencrypt-staging \
   --set ingress.tls.clusterIssuer=letsencrypt-staging \
   --set certManager.acme.server=https://acme-staging-v02.api.letsencrypt.org/directory \
   --set certManager.acme.privateKeySecretName=letsencrypt-staging-account-key \
   --set certManager.acme.email=ops@greenpay.example
   ```

   The chart renders a `ClusterIssuer` named `letsencrypt-staging` and annotates every Ingress with `cert-manager.io/cluster-issuer: "letsencrypt-staging"`. cert-manager then creates a `Certificate` and fills `Secret/greenpay-tls` in the `greenpay` namespace.

4. **Confirm the staging cert landed**, then switch to production ACME (the overlay defaults) and helm-upgrade again with only `--set certManager.acme.email=...` as in §4.3:

   ```bash
   kubectl -n greenpay get certificate
   kubectl -n greenpay get secret greenpay-tls
   kubectl -n greenpay describe certificate
   ```

   `Ready=True` on the Certificate and a `tls.crt`/`tls.key` in `greenpay-tls` means termination is live. Staging certificates are untrusted in browsers; that is expected until this step uses the production directory.

5. **Verify** with `curl -I https://app.greenpay.example/api/health` and a browser cert check. HTTP should 308/301 to HTTPS (`nginx.ingress.kubernetes.io/ssl-redirect` is set when TLS is on).

If the cluster already has a `ClusterIssuer`, leave `certManager.enabled: false` (or `--set certManager.enabled=false`) and point `ingress.tls.clusterIssuer` at that existing issuer. The Ingress `tls` block and annotation still render; the chart just does not create a second issuer.

`ALLOWED_ORIGINS` is derived from `ingress.host` and follows `ingress.tls.enabled`, so the backend's CORS origin always matches the scheme actually served. The guard rejects a Mainnet release whose origins are not `https`.

### Network passphrase

Mainnet uses the public passphrase:

```text
Public Global Stellar Network ; September 2015
```

## 8. Troubleshooting

- `stellar: command not found`: install `stellar-cli` with `cargo install --locked stellar-cli`.
- `contract deploy` fails: confirm the identity has enough XLM and the account exists on Mainnet.
- `Contract ID not configured`: the release was deployed without `--set config.contractId=...`. The guard catches this before deploy; re-run §4.2.
- Backend reports `network: testnet` on Mainnet: the release was rendered from the base values only. Re-run §4.2 with `--expect-network mainnet` — the guard fails on exactly this.
- `Soroban RPC` errors: check `SOROBAN_RPC_URL` in the ConfigMap; override with `--set config.sorobanRpcUrl=...` if your provider differs.
- Guard reports `'helm' not found on PATH`: install Helm 3, or set `HELM_BIN` to its location.
- `ExternalSecret` stuck `SecretSyncedError`: the operator cannot read the backend. Check IRSA/instance role (AWS) or the Vault Kubernetes role, that `secrets.external.remoteKey` exists, and `kubectl -n greenpay describe externalsecret greenpay-secrets`.
- Workloads crash with empty `POSTGRES_PASSWORD`: the release was rendered with `secrets.provider=inline` and no `--set secrets.postgresPassword`. Re-run §4.2; Mainnet must use `provider: external`.

## 9. Optional follow-up

- Update `scripts/register-project.sh` to support Mainnet.
- Add a staging overlay (`values-staging.yaml`) following the same base + overlay convention.
