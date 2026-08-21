# ADR-003: Authentication Approach: Wallet as Identity

## Status

Accepted

## Context and Problem Statement

GreenPay needs to identify donors, project owners, and admins in a way that fits blockchain donations. The platform needed to decide whether to introduce traditional accounts with passwords or OAuth, rely on wallet public keys as identity, or support several wallet providers from the first release.

The current product is centered on Stellar transactions signed in Freighter, public donor profiles, project-owner wallet checks, and on-chain records keyed by Stellar addresses.

## Decision Drivers

- Donors should not need a separate GreenPay password account before donating.
- Private keys must never be handled by the frontend or backend.
- Donation identity should match the Stellar address that signs the transaction.
- Public profiles, leaderboards, badges, and project-owner checks should use a stable identifier.
- The first browser flow should remain simple and testable.
- The platform should leave room for additional Stellar wallets later without changing the identity model.
- Project-owner actions that mutate project data must be protected by cryptographic proof of wallet ownership, not just a submitted public key.

## Considered Options

- Wallet-as-identity with Freighter as the first supported wallet
- Traditional username/password or OAuth accounts
- Multi-wallet support from the first release

## Decision Outcome

Chosen option: Wallet-as-identity with Freighter as the first supported wallet.

GreenPay treats the connected Stellar public key as the primary user identifier. Freighter signs transactions locally, and the app uses the resulting public key for donor profiles, dashboard state, project-owner checks, and transaction authorization flows.

## Proof-of-Wallet Ownership for Project-Owner Actions

To prevent spoofing of the `adminAddress` claim, GreenPay implements a challenge/response flow for project-owner-gated routes:

1. Frontend requests a nonce challenge from `POST /api/projects/:id/auth/challenge`.
2. Backend returns a nonce and the project's `wallet_address`.
3. Frontend builds a small Stellar transaction with the nonce as a text memo and asks Freighter to sign it.
4. Frontend sends the signed XDR to `POST /api/projects/:id/auth/verify`.
5. Backend verifies the signature against `project.wallet_address` and the nonce, then issues a short-lived JWT with `role: projectOwner`.
6. Frontend presents the JWT as `Authorization: Bearer` on subsequent project-owner requests.

Routes protected by this mechanism:
- `POST /api/projects/:id/generate-summary`
- `POST /api/projects/:id/campaigns`
- `POST /api/projects/:id/milestones`
- `PATCH /api/projects/:id/status`

Platform-admin routes continue to use the existing JWT-based `adminRequired` middleware.

## Positive Consequences

- Users can donate without creating a separate platform account.
- Private keys remain inside the wallet extension.
- The public key used for identity is the same address visible in Stellar transactions and Soroban state.
- Donor profiles, leaderboards, and badges can be associated with a durable on-chain identifier.
- The first wallet integration stays focused on one Stellar wallet API instead of several provider-specific APIs.
- Project-owner actions are now protected against spoofed identity claims.

## Negative Consequences

- Users without Freighter need to install it before using the main browser donation flow.
- Account recovery is wallet recovery; GreenPay cannot reset a lost wallet.
- Supporting mobile wallets or other Stellar wallets later will require provider adapters.
- Project-owner actions require an extra signing step, adding minor UX overhead.

## Pros and Cons of the Options

### Wallet-as-identity with Freighter as the first supported wallet

- Good, because it aligns identity with signed Stellar transactions.
- Good, because it avoids password storage and account-recovery operations.
- Good, because Freighter is already integrated into the frontend donation flow.
- Good, because it now includes proof-of-possession for project-owner actions.
- Bad, because Freighter-only support narrows the initial browser wallet audience.

### Traditional username/password or OAuth accounts

- Good, because many users understand conventional sign-in flows.
- Good, because account recovery and notification preferences are easier to model.
- Bad, because account identity can diverge from the wallet that actually donated.
- Bad, because passwords and OAuth sessions add security and privacy responsibilities that are not needed for the core donation flow.

### Multi-wallet support from the first release

- Good, because it would make the product accessible to more Stellar wallet users immediately.
- Good, because it would reduce dependency on one wallet provider.
- Bad, because wallet APIs differ and would add early complexity to signing, network selection, error handling, and tests.
- Bad, because it would slow delivery of the core donation and impact-tracking flows.

## More Information

- [Wallet integration helper](../../frontend/lib/wallet.ts)
- [Wallet connect component](../../frontend/components/WalletConnect.tsx)
- [Architecture security notes](../architecture.md#security)
- [Project owner auth middleware](../../backend/src/middleware/projectOwnerAuth.js)
