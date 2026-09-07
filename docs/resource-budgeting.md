# Resource & Fee Budgeting

Issue **#512** — "No resource or fee budgeting, so a contract call can start
failing once enough data accumulates".

Soroban meters every contract call against hard limits: CPU instructions,
memory, and the ledger read/write footprint. Costs here grow with **accumulated
state**, not just call input — a donation that works today can begin failing as
more donors, badges, and proposals accumulate, and by default that failure is
opaque to the donor.

This document explains how resource consumption is measured and enforced, what
the per-function headroom is, which functions grow with state (and what was done
about them), and how to check the resource impact of a contract change.

## 1. How resource usage is measured

All measurements in this document come from the **host environment** (the
Soroban VM/native test host), not from reasoning about the source:

- **CPU instructions and memory bytes** come from the host budget's cumulative
  cost trackers via `contracts/greenpay-contract/src/resource_measurement.rs`
  (`Budget::cpu_instruction_cost()`, `Budget::memory_bytes_cost()`).
- **Ledger reads/writes** (count and XDR byte estimate of the keys) come from
  the recording footprint (`Env::with_recording_footprint`), diffed across the
  measured call window.

The measurements run against **realistic accumulated state** (a populated-
ledger fixture), not an empty ledger: the `populate` fixture in
`contracts/greenpay-contract/src/resource_budget_test.rs` registers multiple
projects, several donors each making multiple donations across projects,
impact attestations, and a governance proposal before anything is measured.

Those figures are recorded, per entrypoint, in
`contracts/resource-budgets.json`.

### WASM-vs-native caveat

The test host runs the contract **natively as Rust**, which *underestimates*
WASM execution costs. Treat the CPU/memory columns as regression gates and
rough relative guidance, not authoritative on-chain fees. Authoritative numbers
for a specific transaction come from simulating the **built WASM** against a
live (or local) RPC and reading `sorobanData.resources` from the preflight — a
real Soroban host bills CPU, memory, and read/write bytes exactly as the
network will.

The per-transaction budget ceilings themselves are set by the network's current
protocol and change between protocol upgrades; ask the RPC preflight for
today's limits rather than hard-coding them here.

## 2. Per-function headroom report

Measured on the current codebase (native test host; see the caveat above).
Percentages are illustrative against a 100M-instruction reference budget —
check today's real ceiling via preflight before acting on them.

```
FUNCTION                 STATE           CPU_INSNS   MEM_BYTES   READS  WRITES  READ_B  WRITE_B
donate                   fresh ledger        610105      88953       0       8       0      904
initialize               fresh ledger         46150       4406       0       0       0        0
get_project              populated ledger     80748      38143       0       0       0        0
get_donor_stats          populated ledger     82579      37993       0       0       0        0
get_badge                populated ledger     75609      37439       0       0       0        0
get_global_total         populated ledger     60788      36793       0       0       0        0
get_donation_count       populated ledger     61023      36791       0       0       0        0
has_nft                  populated ledger    103371      39711       0       0       0        0
get_token_id             populated ledger    104892      39803       0       0       0        0
owner_of                 populated ledger     65557      36947       0       0       0        0
tokens_of                populated ledger   1232827     312539       6       0     880        0
balance_of               populated ledger    425048      60908       0       0       0        0
get_impact_attestation   populated ledger     90520      39342       0       0       0        0
verify_impact_attestation populated ledger    82983      38732       0       0       0        0
create_proposal          populated ledger    736371     242693       0       2       0      144
vote_verify_project      populated ledger    883315     280575       0       2       0      184
get_proposal             populated ledger     73374      38342       0       0       0        0
anchor_impact_attestation populated ledger    765363     247090       0       2       0      164
revoke_impact_attestation populated ledger   1272846     412455       0       3       0      216
set_dao_contract         populated ledger    450185     160996       0       1       0       56
verify_project           populated ledger    955179     327058       0       2       0      112
transfer                 populated ledger   2403287     678611       6       1     880       56
```

Key takeaways:

- The **donation write path** (`donate`) is a small, fixed-cost call (~610k CPU
  instructions, 8 writes on a fresh donor) — its cost does **not** grow with
  how many other donors/projects exist.  Its cost does grow slightly for an
  existing donor (a second donation re-reads `HasDonated`), but stays constant
  per donation.
- **`initialize`** is a one-time setup cost (~46k CPU, negligible memory).
- Every **read-only getter** is ~60k–105k CPU instructions — negligible and
  flat.
- **`transfer`** is the most expensive single call (~2.4M CPU, ~0.68M memory).
  Most of that is structural (moving entries, fixing up ownership indices and
  the legacy markers), not data growth.
- **`tokens_of`** is proportional to the donor's owned-token vector (that is
  its correct definition — it returns the list). `balance_of` also reads the
  whole vector to take its length. Both grow with how many badges a donor
  happens to own, which is bounded in practice (see §3).
- **Governance** (`create_proposal` / `vote_verify_project`) is constant per
  call; the proposal's vote tally is just two `i128`s.
- **Impact attestations** (`anchor_impact_attestation` ~765k CPU, `revoke_impact_attestation` ~1.27M CPU) are write-heavy but constant per operation.
- **DAO integration** (`set_dao_contract` ~450k CPU, `verify_project` ~955k CPU) replaces the legacy governance path and is also constant per call.

## 3. Functions whose cost grows with accumulated state

| Function | Grows with | Status |
| --- | --- | --- |
| `has_nft`, `get_token_id`, badge auto-mint in `donate` | A donor's owned-token list (was an O(n) scan per call) | **Fixed** — an O(1) representative-token pointer (`DataKey::NftTierToken`) makes the hot path two reads regardless of index size. A stale pointer lazily repairs itself; the regression test `has_nft_is_flat_as_donor_accumulates_tokens` asserts cost stays flat while a donor accumulates 33 same-tier tokens. |
| `transfer` (sender-index removal) | A donor's owned-token list (O(n) scan to remove one id from a `Vec`) | **Guarded** — bounded in practice (a donor self-mints at most `MAX_BADGE_TIERS` + received gifts) and `transfer_removal_is_bounded` caps it in CI. If gifts ever make an index pathologically large, replace the per-owner `Vec` with a per-owner set and shift removal to O(log n). |
| `balance_of`, `tokens_of` | `NftOwnerTokens(owner)` vector length | **Documented** — inherently proportional to what the caller asks to enumerate; reading one stored vector is a single ledger entry. |
| `donate`, getters, attestations, voting, DAO integration | — | Flat. Per-call cost does not depend on total projects/donors/badges. |

Why the expensive-looking paths are bounded:

- NFT **metadata** (`NftMeta(id)`) is a per-token persistent entry; reading one
  token is O(1) regardless of total minted tokens.
- Per-entity records live in **persistent storage** with per-key TTLs, so the
  contract's shared instance footprint does not grow with data (`Admin`,
  counters, allowlist stay in instance storage).

## 4. Budgets are recorded and enforced in CI

`contracts/greenpay-contract/src/resource_budget_test.rs`:

1. **Records** per-entrypoint usage (all measured via the host environment, run
   against the populated-ledger fixture).
2. **Enforces** them against `contracts/resource-budgets.json`: any call that
   exceeds its recorded budget by more than `HEADROOM_FACTOR` (1.75×, to
   absorb native-measurement noise) fails the test with a readable diff.
3. **Guards against re-introducing growth**: the flatness/boundedness tests in
   §3 run independently of the JSON baseline, so they still catch a regression
   even if someone "refreshes" the baseline.

CI runs it via `.github/workflows/contract-deploy.yml`:

```yaml
- name: Enforce resource budgets
  run: cargo test -p greenpay-contract --lib --features testutils resource_budget
```

A change that materially increases the cost of a donation (or silently
re-introduces an O(n) hot path) now fails the build with a report instead of
shipping to production.

## 5. How to check the resource impact of a contract change

For any change to `contracts/greenpay-contract/src/lib.rs`:

1. **Run the suite and read the report** (this is the fast, local-first check):
   ```sh
   cargo test -p greenpay-contract --lib --features testutils resource_budget -- --nocapture
   ```
   It prints the per-function table from §2 and fails if anything blew its
   recorded budget.

2. **For authoritative, network-grade numbers**, build the WASM and simulate
   against a live (or local) RPC; read `sorobanData.resources` from the
   preflight:
   ```sh
   cargo build -p greenpay-contract --target wasm32-unknown-unknown --release
   stellar contract invoke --network testnet \
     --id <CONTRACT_ID> \
     --source <ACCOUNT> --wasm target/wasm32-unknown-unknown/release/greenpay_contract.wasm \
     -- simulate...   # any entrypoint, or via a script that calls simulateTransaction
   ```
   Compare `resources.instructions`, `resources.read_bytes`,
   `resources.write_bytes`, and `minResourceFee` before/after your change.

3. **When a deliberate, reviewed change legitimately changes cost**, refresh
   the baseline *and review the diff as part of the PR*:
   ```sh
   GREENPAY_UPDATE_BUDGETS=1 cargo test -p greenpay-contract --lib --features testutils \
       resource_budget::measure_all_entrypoints_and_compare
   ```
   Then review `git diff contracts/resource-budgets.json`. Do **not** refresh
   the baseline to paper over a regression — review it the way you'd review a
   lockfile or a benchmark result.

4. **If your change touches a hot path**, also check the `has_nft`/`transfer`
   growth guards still pass (they run in the same `resource_budget` filter).

## 6. Client-side fee estimation

| Path | Fee source | Notes |
| --- | --- | --- |
| Frontend contract donation (`frontend/lib/stellar.ts` → `buildContractDonationTransaction`) | **Simulation** — `rpc.assembleTransaction(tx, simulated)` replaces the placeholder fee with the host preflight's `minResourceFee` and attaches the footprint/instructions | The fee a donor pays is derived from the real host estimate, never a constant. |
| Mobile classic payment (`mobile/utils/donationTransaction.ts`) | **Live Horizon fee stats** — `derivePaymentFee(server.feeStats())` = max(minimum, mode × 2) | Classic payments have no simulation; the network's current `fee_charged.mode` is the closest analog, with 2× headroom so a fee spike doesn't drop the donation. |
| Escrow release | **Simulation** — same `rpc.assembleTransaction` path | |

## 7. A call approaching its limits surfaces an actionable error

- `isResourceBudgetFailure` (`frontend/lib/stellar.ts`) detects Soroban budget /
  fee-floor failures (`InsufficientCpuInstructions`, `InsufficientMemory`,
  "budget … exceeds", `txn_too_expensive`) in both the **preflight** path
  (`formatSimulationFailure`) and the **post-submission** path
  (`extractPanicReason`).
- Instead of the old opaque "The contract rejected this call", the donor sees a
  message explaining that the call needs more on-chain resources than the
  transaction allows, that nothing was sent, and that this points to a
  resource-budget review.