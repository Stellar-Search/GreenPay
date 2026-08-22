# Threat Model & Trust Boundary Analysis

This document details the threat model for the Stellar GreenPay platform. It establishes the security assumptions, maps the trust boundaries of the system, and identifies security gaps between the documented architecture and the current implementation.

---

## 1. Trust Boundaries & Assumptions

GreenPay spans several security domains, including client-side wallets, a centralized Node.js API server, PostgreSQL, external AI services, and the on-chain Soroban environment. 

The primary trust boundaries are defined as follows:

```
[ User Browser / Freighter ] <== (A) Wallet-as-Identity ==> [ Node.js Backend ]
                                                              ||
                                                 (B) Admin JWT Auth / Database
                                                              ||
                                                      [ Stellar Network ]
                                                       ||            ||
                                      (C) Matcher Hot Wallet     (D) Contract Admin
```

### Boundary A: Wallet-as-Identity (Client to Backend)
* **Description:** The system relies on the user's Stellar public key (retrieved via Freighter) as their primary identifier.
* **Security Assumption:** Any request purporting to act on behalf of a public key `G...` must prove ownership of that key. The backend must not accept a raw public key without a cryptographic signature proving ownership (proof-of-possession).
* **Threats:** Spoofing, identity theft, unauthorized mutation of profiles or project metadata.

### Boundary B: Admin JWT Authentication (Staff to Backend)
* **Description:** Admin endpoints (`/api/v1/admin/*`) are protected by JSON Web Tokens (JWT) signed by the backend using a shared secret.
* **Security Assumption:** Only authorized platform administrators can generate these tokens. The token secret is cryptographically strong and unique per deployment.
* **Threats:** Weak secrets resulting in token forgery, token leakage, session hijacking, or brute-forcing of credentials.

### Boundary C: The Matcher Hot Wallet (Backend to Horizon)
* **Description:** Automatic donation matching is facilitated by a matcher wallet. Matching payments are signed using the matcher's secret key (`MATCHER_SECRET_KEY`) stored in the backend environment.
* **Security Assumption:** The private key is kept confidential. The backend only uses it to sign transactions that match valid, incoming project donations up to a designated cap.
* **Threats:** Backend server compromise leading to complete key exposure, draining of the matching funds.

### Boundary D: Smart Contract Admin Keys (On-chain Governance)
* **Description:** Soroban contracts (`greenpay-contract`, `escrow-contract`, `dao-governance-contract`) define administrative roles (`admin`, `dao_admin`) that control project registration, deactivation, and governance parameters.
* **Security Assumption:** The administrative keys are held securely by multi-sig wallets or DAO execution accounts. 
* **Threats:** Administrative key loss (permanent denial of service/contract lock), admin key compromise (unauthorized project approvals/arbitrary proposal executions).

---

## 2. Reconciling with ADR-003: Documented Model vs. Current Implementation

**ADR-003** specifies that:
> *"Backend routes that mutate wallet-owned resources must consistently verify wallet ownership or require signed authorization, not just accept a submitted public key."*

However, the current implementation contains significant authorization gaps where the documented security model is not verified:

### Gap 1: Unauthenticated Project Status Updates
* **Location:** `backend/src/routes/projects.js` (`PATCH /api/projects/:id/status`)
* **Stated Model:** Only the project owner or a platform administrator should be allowed to change a project's status (e.g. approve or reject it).
* **Current Vulnerability:** The route accepts `adminAddress` in `req.body` but performs no checks to verify that this address has the authority to make changes. Anyone can send a `PATCH` request to this endpoint with a status of `"rejected"` or `"active"` and arbitrarily alter the visibility and validation state of any project in the database.

### Gap 2: Spoofable AI Summary Generation (Missing Proof-of-Possession)
* **Location:** `backend/src/routes/projects.js` (`POST /api/projects/:id/generate-summary`)
* **Stated Model:** Only the project owner (matching `projects.wallet_address`) can initiate AI summary generation to prevent unauthorized consumption of Anthropic Claude API credits.
* **Current Vulnerability:** While the code checks if `project.wallet_address === adminAddress`, it does not require a signature or cryptographic proof that the client actually owns `adminAddress`. An attacker can spoof this request by supplying the project's public wallet address in the `adminAddress` field, forcing the backend to consume Anthropic API credits and potentially exhausting the service budget.

### Gap 3: JWT Fallback Secret
* **Location:** `backend/src/middleware/auth.js` (`getSecret()`)
* **Stated Model:** Secrets must be strong, unique, and configured at runtime.
* **Current Vulnerability:** The backend falls back to `"dev-secret-do-not-use-in-prod"` if `JWT_SECRET` is not set in the environment. This makes local developer configuration simple but introduces a silent failure mode in production where token signing keys are public.

### Gap 4: Matcher Key Exposure Risk
* **Location:** `backend/src/services/turrets.js` (`submitMatchingPayment()`)
* **Stated Model:** Pre-signed transactions should be used so that the backend does not hold the raw secret key.
* **Current Vulnerability:** The matching server retrieves `MATCHER_SECRET_KEY` from the environment to sign transactions dynamically at runtime. If the backend server is compromised, the attacker gains full control of the matcher wallet.

---

## 3. Remediation Roadmaps

### Immediate Fixes (Required for next minor release)
1. **Enforce JWT Auth on Status Updates:** Secure `PATCH /api/projects/:id/status` by adding the `adminRequired` middleware and verifying that the actor holds a valid admin session.
2. **Implement Cryptographic Challenge-Response for Project Owners:**
   - Implement a challenge endpoint (e.g. `/api/v1/auth/challenge`) that generates a temporary nonce.
   - Force the client to sign the challenge using their Freighter wallet.
   - Verify the signature on the backend using the Stellar SDK (`Keypair.fromPublicKey(addr).verify(...)`) before allowing mutations like summary generation.
3. **Fail-Hard on Missing JWT Secret:** Modify `backend/src/middleware/auth.js` to crash the server on start if `process.env.JWT_SECRET` is absent when running in production (`NODE_ENV === 'production'`).

### Long-Term Hardening
1. **Transition to Pre-Signed Matching:** Deprecate the use of `MATCHER_SECRET_KEY` in backend environment variables. Fully transition the Turrets service to only accept and process pre-signed transactions generated off-line.
2. **Implement Admin Key Rotation in Smart Contracts:** Update the Soroban contracts to support admin rotation (e.g., adding `set_admin(new_admin: Address)`) to mitigate key-loss/compromise scenarios.

---

## 4. Periodic Security Review Process

To prevent divergence between the documented threat model and the actual implementation, the following security-review checklist must be executed before **every major release**:

### Pre-Release Security Checklist

1. **Route Authorization Audit:**
   - [ ] Verify that every route that performs a state change (POST, PUT, PATCH, DELETE) has a corresponding authorization guard.
   - [ ] Verify that any route relying on "wallet identity" verifies a signature (proof-of-possession) rather than accepting a raw public key.
2. **Dependency & Configuration Scanning:**
   - [ ] Run `npm run lint` and `cargo audit` in all subprojects.
   - [ ] Verify that no production environments use hardcoded or default secrets (e.g., JWT fallback).
3. **Key Management Verification:**
   - [ ] Confirm the matcher wallet balance is capped to minimize exposure.
   - [ ] Confirm contract admin keys are held in secure accounts (multi-sig/DAO).
4. **Log & Audit Verification:**
   - [ ] Verify that admin mutations (project registrations, status changes) are properly recorded in `admin_audit_log`.

### Execution Cadence
* **Lead:** Security team or Tech Lead.
* **Schedule:** Triggered automatically upon release candidate branching.
* **Output:** A signed-off review document detailing the verification results of each checklist item.
