# Runbook: Matcher hot wallet key may be compromised

**Severity:** Critical — a leaked key can sign matching payments that move live XLM.

**Owner:** Backend / DevOps on call.

## Summary

GreenPay matches donations by submitting payments from a dedicated "matcher"
account. The matching service (`startTurretsServer`) starts only when the
backend pod has `ENABLE_TURRETS=true` (`backend/src/server.js`) and reads the
matcher's secret key at runtime from `MATCHER_SECRET_KEY`
(`backend/src/services/turrets.js` — if unset, matching payments cannot be
submitted). Both values are injected into the backend pods from the
`greenpay-secrets` Kubernetes Secret / `greenpay-config` ConfigMap
(`k8s/backend.yaml`, `k8s/secret.yaml`, `k8s/configmap.yaml`). The turrets
server runs in the same process as the API backend (default port 3001), so
halting matching halts part of the backend workload.

This runbook covers the two highest-impact cases:

1. The key was **exposed** (secret leak, logs, repo, third party) but not yet
   used by an attacker.
2. The key is **actively misused** (unauthorized transactions observed from the
   matcher account).

## 1. Detect

Signals that the matcher key may be compromised:

- Secret scanning / git history finds `MATCHER_SECRET_KEY` or the S-seed value in
  an unexpected place.
- Unauthorized payments or account merges on the matcher address
  (`SELECT DISTINCT matcher_address FROM donation_matches;`).
- Matching payments submitted when no match should be running (unexpected
  turrets activity in `kubectl logs`).
- The environment where the key is injected was compromised (CI secrets leak,
  pod/container break-out, human error).

## 2. Contain (do this first — assume exposure)

### 2a. Stop new matching immediately

The fastest and cleanest halt is to stop matching while keeping the API up.
Turrets only start when `ENABLE_TURRETS` is exactly `"true"`, so override it:

```bash
# Option A: disable turrets only (recommended — keeps the API serving)
kubectl -n greenpay set env deploy/backend ENABLE_TURRETS=false
kubectl -n greenpay rollout restart deploy/backend
kubectl -n greenpay rollout status deploy/backend --timeout=120s

# Option B: remove the matcher's signing key (matching cannot submit without it)
kubectl -n greenpay patch secret greenpay-secrets -p '{"data":{"MATCHER_SECRET_KEY":""}}'
kubectl -n greenpay rollout restart deploy/backend
kubectl -n greenpay rollout status deploy/backend --timeout=120s

# Option C (if the API must go down too): stop the whole backend
kubectl -n greenpay scale deploy backend --replicas=0
```

### 2b. Confirm matching has actually stopped

```bash
# No new matching submissions in the logs after the restart:
kubectl -n greenpay logs deploy/backend --since=2m | grep -iE "submitMatchingPayment|turrets"

# No new transactions from the matcher address on Horizon:
curl -s "https://horizon-testnet.stellar.org/accounts/<matcher-address>/transactions?limit=5&order=desc"
```

## 3. Assess the blast radius

- **Assume everything the key can sign is exposed.** List what the matcher key
  controls:
  ```sql
  SELECT id, matcher_address, cap_xlm, matched_xlm, multiplier, expires_at
  FROM donation_matches
  WHERE matcher_address = '<matcher-address>'
    AND expires_at > NOW() AND matched_xlm < cap_xlm;
  ```
- Record the matcher account's current XLM balance (Horizon
  `/accounts/<matcher-address>` → native balance).
- Check the on-chain history for any unauthorized activity and copy the hashes
  into the incident ticket.
- If an attacker has the key, they can sign any payment; treat the account
  balance as at risk until the funds are moved.

## 4. Rotate the key

1. **Generate a new matcher keypair** (never reuse the compromised one):
   ```bash
   node -e "const {Keypair}=require('@stellar/stellar-sdk');const k=Keypair.random();console.log(k.publicKey());console.log(k.secret());"
   ```
2. **Fund the new account** from a cold/admin account (a few XLM for fees), e.g.
   for testnet via Friendbot:
   ```bash
   curl -s "https://friendbot.stellar.org?addr=<new-matcher-address>"
   ```
3. **Move the remaining balance** off the compromised account to the new one
   (signing with the compromised key is acceptable here — the goal is to empty
   it):
   ```bash
   # Use the Stellar SDK / stellar-cli to build a payment of the full native
   # balance from <matcher-address> to <new-matcher-address> and submit it.
   ```
4. **Point active matches at the new address**:
   ```sql
   UPDATE donation_matches
   SET matcher_address = '<new-matcher-address>'
   WHERE matcher_address = '<compromised-address>'
     AND expires_at > NOW() AND matched_xlm < cap_xlm;
   ```
5. **Rotate the secret** in Kubernetes:
   ```bash
   # base64-encode the new S-seed and set it in the secret, then restart:
   kubectl -n greenpay create secret generic greenpay-secrets --dry-run=client \
     -o yaml --from-literal=MATCHER_SECRET_KEY='<new-s-seed>' | kubectl apply -f -
   kubectl -n greenpay rollout restart deploy/backend
   kubectl -n greenpay rollout status deploy/backend --timeout=120s
   ```
   > If `greenpay-secrets` is managed declaratively, edit the manifest instead
   > of a dry-run apply, and commit only a placeholder.
6. **Decommission the old account**: after confirming the balance is empty, stop
   using it. Do not destroy it until the on-chain record is captured for the
   incident report.

## 5. Verify

- Backend is healthy and matching works again:
  ```bash
  curl -s http://<backend>/health        # isRunning: true
  kubectl -n greenpay get pods -l app=backend
  ```
- A test donation through a match campaign produces a payment from the **new**
  matcher address (check the turrets logs / Horizon).
- The old account shows a zero/negligible native balance.

## 6. Post-incident

- Rotate any other credential that shared the environment (CI secrets,
  database credentials, the `greenpay-secrets` secret contents) if there is any
  chance the exposure path reached them.
- Confirm the leaked value is removed from all logs/history and invalidated in
  any secret store.
- File the fix to harden the matcher key handling: the key is currently a
  plaintext env var with no circuit breaker — move to short-lived signing
  (per-match pre-signed transactions from a non-deployed account), add a
  kill-switch/feature flag, and alert on unexpected matcher activity.

## References

- `backend/src/services/turrets.js` — matching submission and `MATCHER_SECRET_KEY`.
- `backend/src/server.js` — `startTurretsServer(3001)` boot.
- `k8s/backend.yaml`, `k8s/secret.yaml` — where the key is injected.
- `backend/src/db/schema.sql` — `donation_matches`, `match_state` tables.
- [Runbooks index](README.md)