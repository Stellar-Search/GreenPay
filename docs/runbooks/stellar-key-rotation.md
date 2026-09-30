# Runbook: Stellar Account Authority Rotation

## Overview

Rotation of Stellar account authority (such as `MATCHER_SECRET_KEY` and `SPONSOR_SECRET_KEY`) is fundamentally distinct from standard database password rotation. On the Stellar blockchain, account authority is managed on-chain using public-key cryptography and transaction signers. Replacing an account key requires submitting an on-chain `SetOptions` operation to update signers and thresholds.

> [!CRITICAL]
> Stellar key rotation modifies on-chain account permissions. Misconfiguration (e.g., zeroing weights before registering new signers) can permanently lock the account on-chain.

---

## Targeted Accounts

| Account Role | Environment Variable | Usage | On-Chain Threshold |
| :--- | :--- | :--- | :--- |
| **Donation Matcher** | `MATCHER_SECRET_KEY` | Co-signs Turrets matching transactions | Medium threshold |
| **Sponsor Treasury** | `SPONSOR_SECRET_KEY` | Sponsoring donor account reserves | Medium threshold |
| **Soroban Admin** | Admin Key | Administrative contract functions | High threshold |

---

## Pre-Rotation Checklist

- [ ] Confirm no high-volume matching or sponsorship jobs are currently executing.
- [ ] Ensure account has sufficient XLM balance to meet increased base reserve requirements for additional signers (0.5 XLM per signer entry).
- [ ] Prepare new base32 ED25519 keypair for the target role.
- [ ] Verify access to current active key or multi-sig signers with sufficient threshold weight.

---

## Step-by-Step Rotation Procedure

### Step 1: Generate New Keypair

Generate a fresh, secure Stellar keypair using `stellar-sdk` or Horizon CLI out-of-band:
```javascript
const { Keypair } = require('@stellar/stellar-sdk');
const pair = Keypair.random();
console.log('New Public Key:', pair.publicKey());
console.log('New Secret Key:', pair.secret());
```

### Step 2: Add New Signer On-Chain

Build and submit a `SetOptions` transaction using the **current active key**:
```javascript
const tx = new TransactionBuilder(account, { fee })
  .addOperation(Operation.setOptions({
    signer: {
      ed25519PublicKey: NEW_PUBLIC_KEY,
      weight: 1,
    },
  }))
  .setTimeout(30)
  .build();

tx.sign(CURRENT_KEYPAIR);
await server.submitTransaction(tx);
```

### Step 3: Test New Key Signatures

Submit a non-destructive test operation (e.g. `BumpSequence` or zero-value self-payment) signed with `NEW_SECRET_KEY` to prove the new key has valid signing authority.

### Step 4: Update Workload Secrets

Update the external secret store (AWS Secrets Manager / Vault) or Kubernetes Secret:
- Set `MATCHER_SECRET_KEY` / `SPONSOR_SECRET_KEY` to `NEW_SECRET_KEY`.
- Set `CREDENTIAL_ISSUED_AT_MATCHER` metadata to current ISO timestamp.
- Trigger pod refresh or rollout restart (`kubectl rollout restart rollout/backend -n greenpay`).

### Step 5: Revoke Old Key Authority

Once all workload pods are verified running with the new key, revoke authority from `OLD_PUBLIC_KEY`:
```javascript
const revokeTx = new TransactionBuilder(account, { fee })
  .addOperation(Operation.setOptions({
    signer: {
      ed25519PublicKey: OLD_PUBLIC_KEY,
      weight: 0, // Weight 0 revokes signer status
    },
  }))
  .setTimeout(30)
  .build();

revokeTx.sign(NEW_KEYPAIR);
await server.submitTransaction(revokeTx);
```

---

## Key Risks & Stated Hazards

### 1. In-Flight Transaction Invalidation & Sequence Conflicts
If background workers submit transactions using sequence number $N$ while a `SetOptions` transaction consumes sequence number $N$, or if the old key is revoked while transactions signed by it are in the mempool, those pending transactions will fail with `tx_bad_seq` or `tx_bad_auth`.
*Mitigation:* Temporarily pause queue workers (`pg-boss`) during Step 5.

### 2. Irreversible Account Lockout
Setting master key weight or secondary signer weights below the account's `low_threshold`, `med_threshold`, or `high_threshold` will permanently render the account unable to sign any future transaction.
*Mitigation:* Never remove an existing signer until the new signer is verified active on-chain.

### 3. Base Reserve Floor Exhaustion
Adding signers increases the minimum balance requirement for the Stellar account. If the account balance drops below `(2 + num_signers) * base_reserve`, all transaction submissions will be rejected with `tx_insufficient_balance`.

---

## Verification & Rollback

- **Verification:** Run `node scripts/check-credential-age.js` to verify updated key age tracking.
- **Rollback:** If new key failover fails before Step 5, revert workload secret to `OLD_SECRET_KEY` and execute `SetOptions` weight 0 on `NEW_PUBLIC_KEY`.
