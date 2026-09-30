# Runbook: Credential Compromise & Incident Response

## Overview

This runbook defines the emergency response procedure when a credential or signing key used in GreenPay is suspected or confirmed to be compromised.

> [!IMPORTANT]
> In any compromise scenario:
> 1. Contain access first.
> 2. Revoke and reissue credentials.
> 3. Verify systems are operational with new credentials.
> 4. Conduct blast-radius investigation and post-mortem.

---

## Response Matrix by Credential Type

### 1. PostgreSQL Database Credentials (`POSTGRES_PASSWORD`)

* **Blast Radius:** Full read/write access to PostgreSQL database containing donation records, project metadata, subscriber tables, and user sessions.
* **Containment & Revocation:**
  1. Immediately change password in PostgreSQL out-of-band:
     ```sql
     ALTER USER postgres WITH PASSWORD 'EmergencyNewPassStr0ng!';
     ```
  2. Terminate all active database connections:
     ```sql
     SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'postgres' AND pid <> pg_backend_pid();
     ```
  3. Update Kubernetes Secret or AWS Secrets Manager / Vault secret `POSTGRES_PASSWORD`.
  4. Perform forced pod rollout restart:
     ```bash
     kubectl rollout restart rollout/backend -n greenpay
     ```
* **Scope Investigation:** Inspect PostgreSQL query logs (`pg_stat_activity`, audit logs) for unauthorized data exfiltration or table modification.

---

### 2. Stellar Account Keypairs (`MATCHER_SECRET_KEY` / `SPONSOR_SECRET_KEY`)

* **Blast Radius:**
  * `MATCHER_SECRET_KEY`: Unauthorized co-signing of donation matching transactions.
  * `SPONSOR_SECRET_KEY`: Unauthorized creation/sponsorship of Stellar accounts and lockup of treasury reserves.
* **Containment & Revocation:**
  1. Immediately submit on-chain `SetOptions` operation to revoke old key weight to `0`:
     ```javascript
     Operation.setOptions({
       signer: { ed25519PublicKey: COMPROMISED_PUBLIC_KEY, weight: 0 }
     });
     ```
  2. If treasury XLM reserves are at risk from `SPONSOR_SECRET_KEY`, execute emergency reserve reclamation to safe cold wallet.
  3. Issue new keypair following [Stellar Key Rotation Runbook](./stellar-key-rotation.md).
  4. Update Kubernetes Secret and restart backend workload.
* **Scope Investigation:** Query Horizon transaction history for the compromised public key (`/accounts/{pubkey}/transactions`) to identify invalid transactions.

---

### 3. Resend Email API Key (`RESEND_API_KEY`)

* **Blast Radius:** Ability to send unauthorized transactional emails / phishing messages under `@greenpay.app` domain.
* **Containment & Revocation:**
  1. Log into Resend Console (`https://resend.com/api-keys`).
  2. Immediately delete/revoke the compromised API Key.
  3. Create a new API Key with restricted permissions.
  4. Update `RESEND_API_KEY` in AWS Secrets Manager / Vault / Secret store.
  5. Restart backend services.
* **Scope Investigation:** Review Resend outbound email logs to identify any spam/phishing emails sent during compromise window.

---

### 4. AWS Access Keys (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`)

* **Blast Radius:** Access to S3 WAL/database backup buckets, GCS buckets, or AWS Secrets Manager.
* **Containment & Revocation:**
  1. Log into AWS IAM Console or AWS CLI:
     ```bash
     aws iam update-access-key --access-key-id AKIA... --status Inactive
     ```
  2. Delete compromised IAM access key.
  3. Create new IAM access key for service account.
  4. Update secret store and rollout workloads.
* **Scope Investigation:** Review AWS CloudTrail logs for unauthorized S3 object downloads or IAM API requests.

---

### 5. Admin API Key (`ADMIN_API_KEY`) & JWT Secret (`JWT_SECRET`)

* **Blast Radius:** Administrative API endpoint access (`/api/v1/admin/*`), capability to alter project verification statuses and system settings.
* **Containment & Revocation:**
  1. Rotate `JWT_SECRET` in secret manager immediately. (Changing `JWT_SECRET` instantly invalidates all active admin JWT tokens).
  2. Rotate `ADMIN_API_KEY` to new secure random string (minimum 32 chars).
  3. Rollout backend pods immediately.
* **Scope Investigation:** Audit backend access logs for `/api/v1/admin` requests during incident timeframe.

---

## Emergency Escalation Checklist

- [ ] Execute containment steps for compromised credential type.
- [ ] Verify non-compromised services are operational.
- [ ] Run `node scripts/check-credential-age.js` to ensure all active credentials are valid.
- [ ] File Incident Post-Mortem in `docs/runbooks/incidents/`.
