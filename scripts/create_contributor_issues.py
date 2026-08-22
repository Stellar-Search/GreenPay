#!/usr/bin/env python3
"""
create_issues.py — Bulk-create the GreenPay complex-contribution issue backlog.

Every issue below is grounded in a specific, real gap found by reading the
actual code in this repo (file paths, function names, and line-level
behavior are cited in each issue body) — not generic busywork. They span
frontend, backend, contracts, mobile, the browser extension, the Go
scheduler, and k8s/infra.

Usage:
    export GITHUB_TOKEN=ghp_...      # needs 'repo' scope (issues: write)
    python3 create_issues.py                 # create everything
    python3 create_issues.py --dry-run        # print what would be created
    python3 create_issues.py --start 40 --end 50   # create a slice (retry-friendly)

The script is idempotent-ish: it skips creating an issue if an OPEN issue
with the exact same title already exists, so a partial/interrupted run can
just be re-run.
"""

import argparse
import os
import sys
import time

import requests

REPO = "Stellar-Search/GreenPay"
API = f"https://api.github.com/repos/{REPO}"

TOKEN = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
if not TOKEN:
    try:
        import subprocess

        TOKEN = subprocess.check_output(["gh", "auth", "token"], text=True).strip()
    except Exception:
        pass

if not TOKEN:
    print("ERROR: no GitHub token found. Set GITHUB_TOKEN or run `gh auth login`.", file=sys.stderr)
    sys.exit(1)

SESSION = requests.Session()
SESSION.headers.update(
    {
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
)

# ── Labels ────────────────────────────────────────────────────────────────────
# (name, color, description) — created if missing, reused if they already exist.
LABELS = [
    ("area: frontend", "1D76DB", "Next.js web app"),
    ("area: backend", "0E8A16", "Node/Express API + event sourcing"),
    ("area: contracts", "5319E7", "Soroban/Rust smart contracts"),
    ("area: mobile", "FBCA04", "Expo/React Native app"),
    ("area: extension", "B60205", "Browser extension"),
    ("area: scheduler", "006B75", "Go k8s scheduler plugin"),
    ("area: infra", "C5DEF5", "K8s, Helm, CI/CD, deployment"),
    ("area: cross-cutting", "BFD4F2", "Spans multiple subsystems"),
    ("complexity: high", "D93F0B", "Substantial design/implementation work, not a quick fix"),
    ("security", "E11D21", "Security-relevant"),
]

AREA_LABEL = {
    "Frontend": "area: frontend",
    "Backend": "area: backend",
    "Contracts": "area: contracts",
    "Mobile": "area: mobile",
    "Extension": "area: extension",
    "Scheduler": "area: scheduler",
    "Infra": "area: infra",
    "Cross-cutting": "area: cross-cutting",
}


def ensure_labels():
    resp = SESSION.get(f"{API}/labels", params={"per_page": 100})
    resp.raise_for_status()
    existing = {l["name"] for l in resp.json()}
    for name, color, description in LABELS:
        if name in existing:
            continue
        r = SESSION.post(
            f"{API}/labels",
            json={"name": name, "color": color, "description": description},
        )
        if r.status_code not in (201, 422):  # 422 = already exists (race)
            print(f"  warning: could not create label {name!r}: {r.status_code} {r.text}")
        else:
            print(f"  label ready: {name}")
        time.sleep(0.3)


def build_body(issue: dict) -> str:
    lines = []
    lines.append(f"## Summary\n{issue['summary']}\n")
    lines.append(f"## Details\n{issue['details']}\n")
    if issue.get("approach"):
        lines.append(f"## Suggested Approach\n{issue['approach']}\n")
    lines.append("## Acceptance Criteria")
    for item in issue["acceptance"]:
        lines.append(f"- [ ] {item}")
    lines.append("")
    if issue.get("files"):
        lines.append("## Relevant Files")
        for f in issue["files"]:
            lines.append(f"- `{f}`")
        lines.append("")
    lines.append(
        "---\n*Filed as part of a codebase-wide complexity audit — every issue in this "
        "batch is grounded in a specific, real gap in the current code, not a "
        "placeholder. If anything above no longer matches the code, please comment "
        "and we'll correct/close it.*"
    )
    return "\n".join(lines)


def existing_titles() -> set:
    titles = set()
    page = 1
    while True:
        r = SESSION.get(
            f"{API}/issues",
            params={"state": "all", "per_page": 100, "page": page},
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        for it in batch:
            if "pull_request" in it:
                continue
            titles.add(it["title"])
        if len(batch) < 100:
            break
        page += 1
    return titles


def create_issue(issue: dict, dry_run: bool = False) -> None:
    labels = ["complexity: high", AREA_LABEL[issue["area"]]]
    if issue.get("security"):
        labels.append("security")

    title = f"{issue['area']}: {issue['title']}"
    body = build_body(issue)

    if dry_run:
        print(f"[dry-run] would create: {title}  labels={labels}")
        return

    resp = SESSION.post(
        f"{API}/issues",
        json={"title": title, "body": body, "labels": labels},
    )
    if resp.status_code == 201:
        print(f"  created #{resp.json()['number']}: {title}")
    else:
        print(f"  FAILED ({resp.status_code}) {title}: {resp.text[:300]}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--end", type=int, default=len(ISSUES))
    parser.add_argument("--sleep", type=float, default=1.2, help="seconds between issue creations")
    args = parser.parse_args()

    print(f"Repo: {REPO}")
    print(f"Total issues defined: {len(ISSUES)}")

    print("Ensuring labels exist...")
    if not args.dry_run:
        ensure_labels()

    print("Fetching existing issue titles (for idempotency)...")
    already = existing_titles() if not args.dry_run else set()
    print(f"  {len(already)} existing issues found.")

    slice_ = ISSUES[args.start : args.end]
    print(f"Creating issues [{args.start}:{args.end}] ({len(slice_)} of them)...")

    created = 0
    skipped = 0
    for i, issue in enumerate(slice_, start=args.start):
        full_title = f"{issue['area']}: {issue['title']}"
        if full_title in already:
            print(f"  [{i}] skip (already exists): {full_title}")
            skipped += 1
            continue
        print(f"  [{i}] {full_title}")
        create_issue(issue, dry_run=args.dry_run)
        created += 1
        if not args.dry_run:
            time.sleep(args.sleep)

    print(f"\nDone. Created (or would create): {created}, skipped (already existed): {skipped}")


# ── Issues ──────────────────────────────────────────────────────────────────
ISSUES = [

# ═══════════════════════════════════════════════════════════════════════════
# CONTRACTS (Soroban / Rust) — 12
# ═══════════════════════════════════════════════════════════════════════════

dict(
    area="Contracts",
    title="escrow-contract violates Checks-Effects-Interactions ordering, unlike greenpay-contract",
    security=True,
    summary="release_escrow, resolve_dispute, and cancel_job in escrow-contract update `job.status` AFTER the external token transfer, exactly the pattern greenpay-contract was hardened against.",
    details=(
        "In `contracts/escrow-contract/src/lib.rs`, `release_escrow` (line ~94), `resolve_dispute` "
        "(line ~141), and `cancel_job` (line ~181) all call `token_client.transfer(...)` and only "
        "*afterwards* set `job.status = JobStatus::Released/Refunded` and write it back to storage. "
        "Contrast this with `greenpay-contract/src/lib.rs`'s `donate()` (line ~275), which has an explicit "
        "comment block: \"Effects: all state writes BEFORE the external token transfer (Checks-Effects-"
        "Interactions to defend against reentrancy from a malicious token contract passed via `token`)\" — "
        "and `contracts/greenpay-contract/SECURITY.md` documents this exact audit finding and fix. "
        "escrow-contract accepts an arbitrary `token: Address` in `create_job` with no allowlist (see the "
        "related issue on token-contract trust), so a non-standard or malicious token implementation could "
        "exploit the state-after-transfer ordering here in a way the audited contract already closed off."
    ),
    approach=(
        "Reorder each of the three functions so `job.status` is written to storage before "
        "`token_client.transfer(...)` is called, mirroring `donate()`'s pattern exactly. Add a regression "
        "test analogous to greenpay-contract's `test_donate_basic_flow_after_cei_reorder`."
    ),
    acceptance=[
        "release_escrow, resolve_dispute, and cancel_job all write `job.status` before calling `token_client.transfer`.",
        "A test exists proving state is correctly persisted even if a mock malicious token's `transfer` were to attempt reentrant calls.",
        "contracts/escrow-contract gets its own SECURITY.md documenting this fix, matching greenpay-contract's convention.",
        "All existing escrow-contract tests continue to pass unchanged.",
    ],
    files=["contracts/escrow-contract/src/lib.rs", "contracts/greenpay-contract/SECURITY.md"],
),

dict(
    area="Contracts",
    title="escrow-contract dispute resolution has a single admin with no timeout fallback — funds can be frozen forever",
    summary="If the single admin never calls resolve_dispute on a disputed job, the escrowed funds are frozen indefinitely with no recovery path for either party.",
    details=(
        "`dispute()` moves a job to `JobStatus::Disputed` (contracts/escrow-contract/src/lib.rs, line ~118), "
        "and the only way out of that state is `resolve_dispute()`, which requires `admin.require_auth()` "
        "against a single address stored at initialization. There is no timeout, no fallback arbitration "
        "path, and no way for the client or freelancer to force a resolution if the admin is unavailable, "
        "compromised, or simply stops responding — `cancel_job()` explicitly only works from `JobStatus::"
        "Escrowed`, not `Disputed` (line ~191: `if job.status != JobStatus::Escrowed { panic!(...) }`), so "
        "once a dispute is raised the funds are provably stuck without the admin's cooperation."
    ),
    approach=(
        "Design a fallback: e.g. after N ledgers in Disputed with no resolution, allow an automatic 50/50 "
        "split, or integrate with dao-governance-contract's execute_proposal so a DAO vote can resolve a "
        "stale dispute (see the related cross-contract-authority issue) instead of a single admin key."
    ),
    acceptance=[
        "A documented, tested fallback path exists for disputes the admin never resolves.",
        "The fallback cannot be triggered before a defined minimum ledger window has elapsed.",
        "Existing single-admin resolve_dispute behavior is preserved for the normal case.",
        "Tests cover: admin resolves promptly (existing behavior), admin never resolves + fallback triggers correctly, fallback cannot be triggered early.",
    ],
    files=["contracts/escrow-contract/src/lib.rs"],
),

dict(
    area="Contracts",
    title="No real on-chain upgrade mechanism exists despite deployment tooling claiming \"upgradeable\": true",
    summary="None of the three contracts implement env.deployer().update_current_contract_wasm(...) — the CI-generated deployment manifest's \"upgradeable\": true is currently false.",
    details=(
        "`grep -rn \"update_current_contract_wasm\\|fn upgrade\" contracts/*/src/lib.rs` returns nothing. "
        "greenpay-contract's own test suite has `test_upgrade_preserves_donation_state_and_storage_keys`, "
        "but reading it shows it only asserts storage *keys* remain readable under a hand-simulated scenario "
        "— there is no actual WASM-hash-swap entrypoint anywhere. Meanwhile `.github/workflows/contract-"
        "deploy.yml`'s generated `deployment-manifest.json` labels all three contracts `\"upgradeable\": "
        "true`. If a bug is ever found post-deployment (and this audit found several — see the CEI and "
        "voting-power issues), there is currently no way to fix a live contract without a full redeploy to "
        "a new contract ID, which breaks every existing integration (backend `CONTRACT_ID` env var, "
        "frontend, mobile, extension) and abandons all on-chain history."
    ),
    approach=(
        "Add an admin-gated (or DAO-governed, via dao-governance-contract's execute_proposal — see the "
        "related cross-contract-authority issue) `upgrade(new_wasm_hash: BytesN<32>)` function to each "
        "contract using `env.deployer().update_current_contract_wasm(new_wasm_hash)`, with appropriate "
        "auth checks and an emitted event."
    ),
    acceptance=[
        "All three contracts (greenpay, escrow, dao-governance) implement a real, auth-gated upgrade function.",
        "A test proves storage/state survives a real upgrade (deploy V1, invoke, upgrade to V2 WASM, verify state and new behavior).",
        "Access control on the upgrade function is deliberate (admin-only, or DAO-governed with timelock) and documented.",
        "deployment-manifest.json generation in CI reflects the real mechanism, not just a label.",
    ],
    files=["contracts/greenpay-contract/src/lib.rs", "contracts/escrow-contract/src/lib.rs", "contracts/dao-governance-contract/src/lib.rs"],
),

dict(
    area="Contracts",
    title="dao-governance-contract's snapshotted voting power can be retroactively inflated via extend_lock after the snapshot",
    security=True,
    summary="get_voting_power recomputes historical power from the voter's CURRENT (mutable) Lock record — extending a lock after a proposal's snapshot_ledger has already passed inflates the voter's power for that historical vote.",
    details=(
        "`get_voting_power(env, voter, at_ledger)` (contracts/dao-governance-contract/src/lib.rs, line ~255) "
        "does NOT read a point-in-time checkpoint — it fetches the voter's single, current `Lock` record "
        "(`DataKey::Lock(voter)`) and computes `remaining = lock.unlock_ledger - at_ledger`, weighting power "
        "by that. `extend_lock()` (line ~199) mutates `lock.unlock_ledger` in place without changing "
        "`created_ledger`. Sequence: a voter with an existing lock is included in `advance_to_snapshot`'s "
        "snapshot_ledger; before they `cast_vote()`, they call `extend_lock()` to push `unlock_ledger` far "
        "into the future; when they then vote, `get_voting_power(voter, proposal.snapshot_ledger)` computes "
        "`remaining` using the NEW, extended `unlock_ledger` — giving them more voting power for that past "
        "snapshot than they actually held at snapshot time. This defeats the entire purpose of "
        "snapshotting (the deleted issue that originally motivated this feature was explicitly about "
        "preventing exactly this class of \"manipulate voting power between snapshot and vote\" attack) — "
        "it just moves the attack vector from flash-loaning tokens to flash-extending a lock. Note the "
        "`at_ledger < lock.created_ledger` check (line ~267) DOES correctly block a brand-new lock created "
        "after the snapshot, so this is specifically about the extend-lock path, not new locks."
    ),
    approach=(
        "Store an actual checkpoint of `(amount, unlock_ledger, created_ledger)` at the moment a proposal "
        "advances to SnapshotVote for every currently-locked voter (or, more scalably, record a per-voter "
        "checkpoint on every lock/extend_lock mutation, so historical lookups read the checkpoint that was "
        "current AT `at_ledger`, not the present-day mutable record)."
    ),
    acceptance=[
        "A regression test proves: voter locks tokens, proposal snapshot is taken, voter calls extend_lock, voter votes — their counted voting power matches what they held AT the snapshot, not after the extension.",
        "get_voting_power no longer derives historical power from a mutable present-day record for any input at_ledger in the past.",
        "Existing lock/extend_lock/withdraw/vote tests all continue to pass.",
        "The fix is documented in a SECURITY.md for dao-governance-contract (see the related audit-parity issue).",
    ],
    files=["contracts/dao-governance-contract/src/lib.rs"],
),

dict(
    area="Contracts",
    title="dao-governance-contract's execute_proposal invokes arbitrary calldata on any contract with no target allowlist",
    summary="create_proposal accepts an unrestricted target_contract/function/calldata triple from any address with positive voting power — a passing vote can trigger any function call on any contract.",
    details=(
        "`create_proposal` (contracts/dao-governance-contract/src/lib.rs, line ~282) stores `target_contract: "
        "Address`, `function: Symbol`, and `calldata: Bytes` supplied entirely by the proposer, with zero "
        "validation beyond \"proposer has positive voting power\". `execute_proposal` (line ~495) then does "
        "`env.invoke_contract::<()>(&proposal.target_contract, &proposal.function, args)` after the timelock "
        "elapses — a fully generic, unrestricted executor. This is a deliberate and powerful pattern (it's "
        "how the missing upgrade functions in the other two contracts should plausibly be wired, per the "
        "related upgrade-mechanism issue), but as-is there is no allowlist of which contracts/functions the "
        "DAO is meant to be able to call, meaning a successful (quorum + majority) vote — which per the "
        "companion voting-power-inflation issue may itself be manipulable — could invoke literally anything, "
        "including functions with no business being DAO-governed."
    ),
    approach=(
        "Introduce an admin- or self-governed allowlist of (target_contract, function) pairs the DAO is "
        "permitted to execute, checked in create_proposal or execute_proposal, with a defined process for "
        "updating the allowlist itself."
    ),
    acceptance=[
        "create_proposal or execute_proposal rejects target_contract/function combinations not on an allowlist.",
        "The allowlist itself is stored on-chain and has a defined, tested update path.",
        "A test proves a proposal targeting a non-allowlisted contract/function cannot be created (or cannot execute).",
        "Existing legitimate proposal-execution tests continue to pass with their targets added to the allowlist.",
    ],
    files=["contracts/dao-governance-contract/src/lib.rs"],
),

dict(
    area="Contracts",
    title="greenpay-contract stores every unbounded, per-entity record in instance storage instead of persistent storage with per-key TTLs",
    summary="Project, DonorStats, ImpactNFT, HasDonated, Proposal, and HasVoted — every growing, per-project/per-donor record type — all live in Soroban \"instance\" storage, which doesn't scale and risks hitting ledger entry size limits.",
    details=(
        "`grep -n \"storage()\\.\" contracts/greenpay-contract/src/lib.rs` shows every single call site uses "
        "`env.storage().instance()`, never `.persistent()`. The `DataKey` enum (line ~98) includes "
        "`Project(String)`, `DonorStats(Address)`, `ImpactNFT(Address, BadgeTier)`, `HasDonated(String, "
        "Address)`, `Proposal(String)`, and `HasVoted(String, Address)` — every one of these grows without "
        "bound as the platform gains projects and donors. Soroban's instance storage is documented as "
        "intended for small, contract-wide configuration data with a single combined TTL/footprint bumped "
        "on every invocation; persistent storage with individually-managed per-key TTLs (which dao-"
        "governance-contract correctly uses via its `extend_persistent_ttl` helper for `Lock`, `Proposal`, "
        "and `Snapshot` entries) is the documented, correct choice for unbounded per-entity data. As-is, "
        "*every single call to this contract* — even one just reading a single donor's badge — pays the "
        "rent-bump cost of the entire, ever-growing instance storage footprint, and there is a hard ledger "
        "entry size ceiling this contract will eventually hit as projects/donors scale."
    ),
    approach=(
        "Migrate `Project`, `DonorStats`, `ImpactNFT`, `HasDonated`, `Proposal`, and `HasVoted` to persistent "
        "storage with per-key `extend_ttl` calls, matching dao-governance-contract's pattern. This requires "
        "a data-migration strategy for any already-deployed instance (ties into the missing-upgrade-"
        "mechanism issue), since it changes the storage location of existing entries."
    ),
    acceptance=[
        "All per-entity DataKey variants are moved to persistent storage with explicit, tested TTL extension on every read/write.",
        "A migration path is designed and tested for converting existing instance-storage entries (if any exist on a live deployment) without data loss.",
        "A test simulates registering hundreds of projects/donors and asserts contract calls remain performant/within size limits.",
        "Documentation explains the storage-type choice for future contributors adding new DataKey variants.",
    ],
    files=["contracts/greenpay-contract/src/lib.rs"],
),

dict(
    area="Contracts",
    title="escrow-contract supports only a single, full-amount release — no milestone-based partial payments",
    summary="create_job/release_escrow lock and release one lump sum; there's no way to pay a freelancer incrementally as milestones complete, forcing all-or-nothing risk on both parties.",
    details=(
        "The `Job` struct (contracts/escrow-contract/src/lib.rs, line ~24) has a single `amount: i128` and "
        "`release_escrow` transfers the entire amount in one call, moving status straight to `JobStatus::"
        "Released`. There is no concept of partial release against a remaining balance, no milestone list, "
        "and no way to release, say, 30% now and the rest later — every freelance job funded through this "
        "contract must be paid in one all-or-nothing transaction, which is a poor fit for real freelance "
        "work (the type of feature `greenpay-contract`'s own project-milestone tracking, referenced "
        "elsewhere in the docs, suggests was intended)."
    ),
    approach=(
        "Add a `remaining_amount` (or a `Vec<Milestone>` with amounts) to `Job`, a `release_partial(amount)` "
        "entrypoint that transfers a portion and decrements the remaining balance without changing status "
        "until fully paid, and decide how `dispute`/`cancel_job`/`resolve_dispute` interact with a "
        "partially-released job."
    ),
    acceptance=[
        "Jobs can be created with either a single amount (existing behavior, unchanged) or a milestone schedule.",
        "release_escrow can release a partial amount, leaving the job Escrowed with a reduced remaining balance.",
        "Dispute/cancel/resolve semantics are explicitly defined and tested for a partially-released job.",
        "All existing single-release tests continue to pass unchanged.",
    ],
    files=["contracts/escrow-contract/src/lib.rs"],
),

dict(
    area="Contracts",
    title="greenpay-contract's own project-verification voting and dao-governance-contract are two disconnected, incompatible governance systems",
    summary="greenpay-contract's create_proposal/vote_verify_project (1-address-1-vote, admin-controlled) has no relationship to the far more sophisticated dao-governance-contract (lock-weighted, snapshotted, arbitrary execution) — project verification isn't actually DAO-governed.",
    details=(
        "`contracts/greenpay-contract/src/lib.rs` implements its own, independent voting system: "
        "`create_proposal` (line ~535) requires the contract's OWN stored `Admin` (not the DAO), and "
        "`vote_verify_project` (line ~592) is a flat one-address-one-vote scheme gated only on holding any "
        "badge tier. This has nothing to do with `dao-governance-contract`'s lock-weighted, snapshotted, "
        "timelocked, arbitrary-calldata-executing governance system — they're architecturally incompatible "
        "philosophies for \"voting\" living in the same repo with no integration. A single admin key can "
        "create and effectively control project-verification outcomes independent of any actual DAO vote, "
        "which undercuts the premise that dao-governance-contract is the platform's real governance layer."
    ),
    approach=(
        "Decide whether project verification should be migrated to run through dao-governance-contract's "
        "execute_proposal (calling a would-be `verify_project` entrypoint on greenpay-contract, gated by "
        "the DAO's own quorum/snapshot/timelock machinery) or remain intentionally separate — and if "
        "separate, document why two different governance models coexist and harden greenpay-contract's own "
        "voting per the related Sybil-resistance issue."
    ),
    acceptance=[
        "A documented architectural decision exists for the relationship (or intentional separation) between the two governance systems.",
        "If integrated: project verification proposals can only be created/resolved via a DAO-approved execute_proposal call.",
        "If kept separate: greenpay-contract's own admin-gated voting is explicitly documented as a distinct, narrower-scope mechanism with its own security model.",
        "Tests cover the chosen integration (or explicit non-integration) path end to end.",
    ],
    files=["contracts/greenpay-contract/src/lib.rs", "contracts/dao-governance-contract/src/lib.rs"],
),

dict(
    area="Contracts",
    title="greenpay-contract's project-verification vote is Sybil-attackable — 1 badge-holder address = 1 vote, with a cheap badge threshold",
    security=True,
    summary="vote_verify_project weighs every badge-holding address's vote identically regardless of donation size, and the minimum badge (Seedling, ≈10 XLM) is cheap enough that an attacker can mint many voting addresses.",
    details=(
        "`vote_verify_project` (contracts/greenpay-contract/src/lib.rs, line ~592) only checks `stats.badge "
        "!= BadgeTier::None` — any address that has ever donated enough to cross the lowest badge threshold "
        "(Seedling, computed in `backend/src/services/store.js`'s `computeBadges` as ~10 XLM based on this "
        "session's test fixtures) gets exactly one vote, identical in weight to a donor who gave thousands "
        "of XLM. An attacker can create many Stellar addresses, donate the ~10 XLM minimum from each "
        "(a cost that scales linearly and cheaply with the number of votes desired), and cast many votes to "
        "swing a project-verification outcome — there is no weighting by donation size and no per-identity "
        "cost beyond the flat minimum-badge threshold."
    ),
    approach=(
        "Weight votes by donor_stats.total_donated (or badge tier) rather than counting every badge holder "
        "equally, and/or introduce a higher, deliberately-costlier eligibility bar for voting specifically "
        "(distinct from the badge tiers used for donor recognition elsewhere)."
    ),
    acceptance=[
        "Vote weight is derived from donation size/tier rather than a flat 1-address-1-vote count, or an equivalent Sybil-resistance mechanism is implemented.",
        "A test models a Sybil scenario (many minimum-threshold donors vs. one large donor) and proves the outcome reflects intended economic weight.",
        "The chosen threshold/weighting is documented with its cost-of-attack rationale.",
        "Existing legitimate single-voter tests continue to pass.",
    ],
    files=["contracts/greenpay-contract/src/lib.rs", "backend/src/services/store.js"],
),

dict(
    area="Contracts",
    title="mint_impact_nft badges aren't a real token/NFT standard — invisible to wallets, explorers, and marketplaces",
    summary="ImpactNFT is just an instance-storage flag with metadata; it doesn't implement SEP-41 or any NFT interface, so donors can never see, transfer, or display their \"NFT\" outside this specific contract's own get/has_nft calls.",
    details=(
        "`mint_impact_nft` (contracts/greenpay-contract/src/lib.rs, line ~482) creates an `ImpactNFT` struct "
        "and writes it to `env.storage().instance().set(&DataKey::ImpactNFT(donor, tier), &nft)` — this is "
        "purely an internal boolean-ish marker with attached metadata (`owner`, `tier`, `total_donated`, "
        "`minted_at_ledger`). It implements no token interface (not SEP-41, not a transfer/approve/balance "
        "model of any kind), so no Stellar wallet, block explorer, or NFT marketplace can ever discover, "
        "display, or let a donor transfer this \"NFT\" — the feature is only visible through this contract's "
        "own `has_nft`/`get_badge` reads, which undercuts the stated purpose (donors owning a real, "
        "verifiable, portable collectible for their giving)."
    ),
    approach=(
        "Either implement a minimal real token/NFT interface (transfer, owner_of, balance_of at minimum) so "
        "external tooling can discover these badges, or explicitly reframe/document them as an internal "
        "\"achievement flag\" rather than an NFT, and update any user-facing copy that currently implies "
        "otherwise."
    ),
    acceptance=[
        "A decision is made and implemented: either a real minimal NFT/token interface, or explicit internal-flag framing with corrected user-facing copy across frontend/mobile.",
        "If implementing a real interface: a test proves the badge is discoverable/queryable via the standard interface, not just this contract's custom getters.",
        "Documentation clarifies what \"Impact NFT\" actually means to a donor.",
    ],
    files=["contracts/greenpay-contract/src/lib.rs"],
),

dict(
    area="Contracts",
    title="create_job/donate accept an arbitrary token Address with no trust validation",
    security=True,
    summary="Both escrow-contract's create_job and greenpay-contract's donate accept any Address as the payment token with zero allowlist — a malicious or non-standard token implementation is fully trusted.",
    details=(
        "`create_job(env, client, freelancer, job_id, token: Address, amount, expiry_ledger)` (contracts/"
        "escrow-contract/src/lib.rs, line ~57) and `donate(env, token: Address, ...)` (contracts/greenpay-"
        "contract/src/lib.rs, line ~275) both construct a `token::Client::new(&env, &token)` from a caller-"
        "supplied address with no check that it's a recognized/trusted asset contract (e.g. the native XLM "
        "SAC, or a specific allowlisted USDC issuer). A caller could pass any contract address implementing "
        "a token-shaped interface — including one with non-standard behavior (fee-on-transfer, callback "
        "hooks, transfer amounts that don't match what was requested) — and both contracts would process it "
        "as if it were a trustworthy asset."
    ),
    approach=(
        "Introduce an admin-managed allowlist of accepted token contract addresses per contract, checked "
        "before any transfer is attempted, or document explicitly (with a threat-model writeup) why "
        "accepting arbitrary tokens is an intentional, accepted trust boundary."
    ),
    acceptance=[
        "Either an allowlist of accepted token addresses is enforced in create_job and donate, or a documented threat-model explains why it's intentionally unrestricted.",
        "If allowlisted: a test proves a non-allowlisted token address is rejected before any transfer is attempted.",
        "Existing tests using the standard testnet asset contract continue to pass.",
    ],
    files=["contracts/escrow-contract/src/lib.rs", "contracts/greenpay-contract/src/lib.rs"],
),

dict(
    area="Contracts",
    title="dao-governance-contract's per-vote Snapshot entries accumulate forever with no archival path",
    summary="Every cast_vote call persists a Snapshot(proposal_id, voter) entry that is never cleaned up once a proposal is finalized, growing storage indefinitely as the DAO accumulates history.",
    details=(
        "`cast_vote` (contracts/dao-governance-contract/src/lib.rs, line ~395) writes a `Snapshot` "
        "(`DataKey::Snapshot(proposal_id, voter)`) for every voter on every proposal, correctly extending "
        "its persistent TTL via `extend_persistent_ttl`. But nothing ever removes these entries once a "
        "proposal reaches `Executed`/`Defeated` — they exist solely to prevent double-voting during the "
        "active voting window (checked via `env.storage().persistent().has(&snap_key)` in the same "
        "function), yet persist (and keep consuming rent-bumped storage) forever after they're no longer "
        "needed for anything. For an active DAO with many proposals and voters, this is unbounded storage "
        "growth with no archival, expiry, or cleanup mechanism."
    ),
    approach=(
        "Once a proposal is finalized (Executed or Defeated), either let its Snapshot entries' TTLs lapse "
        "naturally (don't keep re-extending them — verify this doesn't break anything else) or add an "
        "explicit archival/cleanup entrypoint callable after finalization."
    ),
    acceptance=[
        "Snapshot entries for a finalized proposal are not indefinitely rent-bumped/extended.",
        "A documented storage-growth analysis exists for realistic DAO usage (N proposals x M voters).",
        "No regression to the double-vote-prevention behavior during an active voting window.",
    ],
    files=["contracts/dao-governance-contract/src/lib.rs"],
),


# ═══════════════════════════════════════════════════════════════════════════
# BACKEND (Node.js / Express / event sourcing) — 16
# ═══════════════════════════════════════════════════════════════════════════

dict(
    area="Backend",
    title="CRITICAL: PATCH /api/projects/:id/status has no authorization check at all — any caller can approve or reject any project",
    security=True,
    summary="The route's own docstring says adminAddress \"must match the project wallet (owner) or be a platform admin\", but the handler never checks adminAddress against anything before updating the project's status.",
    details=(
        "`router.patch(\"/:id/status\", ...)` in `backend/src/routes/projects.js` (line ~607) destructures "
        "`{ status, reason, adminAddress }` from the request body, validates `status` is one of "
        "active/rejected/paused, loads the project, and then runs `UPDATE projects SET status = $1, "
        "rejection_reason = $2, updated_at = NOW() WHERE id = $3` UNCONDITIONALLY — `adminAddress` is read "
        "but never compared to `project.wallet_address`, never checked against a platform-admin list, "
        "never used for anything except the (spoofable) audit-log `actor` field. This means any "
        "unauthenticated request to this endpoint can approve an unverified project or reject/sabotage any "
        "existing project, with no proof of ownership or admin privilege required whatsoever. Compare this "
        "to `backend/src/routes/admin.js`, which correctly uses JWT-based `adminRequired` middleware "
        "(`backend/src/middleware/auth.js`) for platform-admin actions — this route has no equivalent "
        "protection at all."
    ),
    approach=(
        "At minimum, restore the documented check (`adminAddress === project.wallet_address` or a platform-"
        "admin allowlist) before allowing the update — but see the companion issue about that pattern itself "
        "being spoofable, since `adminAddress` has no proof of wallet ownership. The real fix likely needs "
        "both: an authorization check present at all, AND that check backed by actual signature verification."
    ),
    acceptance=[
        "The route rejects the request (403) unless adminAddress matches project.wallet_address or a verified platform admin.",
        "A regression test proves an unauthenticated/mismatched-address request cannot change a project's status.",
        "The fix is deployed with urgency given real funds/reputation are at stake — flag for immediate triage, not routine backlog.",
        "Audit-log actor field reflects only verified identity, not an unchecked client claim.",
    ],
    files=["backend/src/routes/projects.js", "backend/src/middleware/auth.js"],
),

dict(
    area="Backend",
    title="Project-owner actions trust a client-supplied adminAddress with no proof of wallet ownership",
    security=True,
    summary="generate-summary and campaign-creation routes compare req.body.adminAddress to project.wallet_address, but nothing proves the caller actually controls that wallet's private key — the identity claim is fully spoofable.",
    details=(
        "`POST /api/projects/:id/generate-summary` (backend/src/routes/projects.js, line ~474) does check "
        "`if (project.wallet_address !== adminAddress) return 403`, which is *more* than the status-update "
        "route does (see the companion CRITICAL issue) — but `adminAddress` is still just a string read "
        "from the request body with zero cryptographic proof of possession (no signature challenge, no "
        "session tied to a signed message, nothing). Since a project's `wallet_address` is public "
        "information shown on its own project page, ANY attacker can POST `{\"adminAddress\": \"<any "
        "project's real public wallet address>\"}` and be treated as that project's verified owner — "
        "triggering paid Claude API summary generation on someone else's budget, or (per campaign-creation "
        "call sites using the same `req.body?.adminAddress` pattern at lines ~239/292/319) creating funding "
        "campaigns attributed to a project they don't control. `docs/adr/ADR-003-authentication-approach-"
        "wallet-as-identity.md` documents wallet-as-identity as the intended model, but no route actually "
        "implements proof-of-possession for it — the frontend's client-side `isOwner = publicKey === "
        "project.walletAddress` check (pages/admin/[projectId].tsx) is a reasonable UX gate (Freighter only "
        "loads keys the user controls), but the backend has no equivalent guarantee for the raw API."
    ),
    approach=(
        "Implement a real proof-of-wallet-ownership mechanism for project-owner actions — e.g. a SEP-10-"
        "style challenge/response (server issues a nonce, owner signs it with their Stellar key via "
        "Freighter, server verifies the signature against project.wallet_address) — and require it "
        "consistently across every project-owner-gated route, not just some."
    ),
    acceptance=[
        "A challenge/response (or equivalent) proof-of-ownership mechanism is implemented and required for all project-owner actions.",
        "generate-summary, campaign creation, and any other adminAddress-gated route are updated consistently.",
        "A test proves an attacker who knows a project's public wallet_address, but doesn't control its key, cannot pass authorization.",
        "ADR-003 is updated to reflect the actual implemented mechanism.",
    ],
    files=["backend/src/routes/projects.js", "docs/adr/ADR-003-authentication-approach-wallet-as-identity.md"],
),

dict(
    area="Backend",
    title="EventStoreService.append()'s ON CONFLICT clause makes its own idempotency flag meaningless, and 6 command handlers bypass it entirely",
    summary="append()'s \"ON CONFLICT DO UPDATE SET payload = event_stream.payload\" is a no-op update that Postgres still reports as an affected row, so the returned `inserted` flag is always true — and commandBus.js duplicates the same raw INSERT six times instead of calling this method.",
    details=(
        "`backend/src/eventSourcing/eventStore.js`'s `append()` (line ~17) does `INSERT INTO event_stream "
        "(...) VALUES (...) ON CONFLICT (stream_id, version) DO UPDATE SET payload = event_stream.payload` "
        "then returns `inserted: result.rowCount === 1`. Postgres reports `rowCount` as 1 for a matched `DO "
        "UPDATE` regardless of whether any column value actually changed (self-assignment is still a "
        "row-touch), so `inserted` can never be false — any caller relying on it to detect \"this was "
        "already recorded\" gets a false signal. Separately, `append()`/`appendBatch()` are barely used: "
        "`grep -rn \"eventStore\\.\\|\\.append(\"` shows only `migrate.js` calls `appendBatch`. Every command "
        "handler in `backend/src/eventSourcing/commandBus.js` (DonationCommandHandler, ApplyMatchCommand-"
        "Handler, ChangeProjectStatusCommandHandler, ReachMilestoneCommandHandler, ReleaseEscrowCommand-"
        "Handler, CreateMatchOfferCommandHandler — six of them) instead duplicates the exact same 11-column "
        "raw INSERT INTO event_stream SQL statement inline, bypassing the class that's supposed to "
        "encapsulate this and its (broken) conflict-detection semantics entirely."
    ),
    approach=(
        "Fix the ON CONFLICT clause to actually distinguish insert-vs-duplicate (e.g. `DO NOTHING` plus a "
        "follow-up existence check, or a `xmax = 0` trick), then refactor all six commandBus.js handlers to "
        "call `eventStore.append()` instead of duplicating the INSERT."
    ),
    acceptance=[
        "append()'s `inserted` flag is provably accurate (test: insert same stream_id+version twice, assert first is true, second is false).",
        "All six command handlers in commandBus.js call eventStore.append() instead of duplicating the SQL.",
        "No behavior change to existing donation/match/status-change/milestone/escrow/match-offer flows.",
        "Existing dedup-by-transactionHash logic in DonationCommandHandler continues to work (it's currently a separate, explicit SELECT — verify it's still needed or can be simplified once append() is fixed).",
    ],
    files=["backend/src/eventSourcing/eventStore.js", "backend/src/eventSourcing/commandBus.js"],
),

dict(
    area="Backend",
    title="Command handlers' multi-step writes aren't transactional, and indexerService.js's wrapping transaction is a no-op that provides false atomicity",
    summary="commandBus.js's handlers do several sequential pool.query() calls with no BEGIN/COMMIT; indexerService.js wraps a call to execute() in its own client-scoped transaction, but execute() writes through the shared pool on different connections, so that outer BEGIN/COMMIT protects nothing.",
    details=(
        "Every handler in `backend/src/eventSourcing/commandBus.js` (e.g. `DonationCommandHandler.handle`, "
        "line ~52) performs several independent `pool.query()` calls — check existing, check project, load "
        "project/donor aggregate state, `storeProjectAggregate`, `storeDonorAggregate`, insert into "
        "`event_stream` — with no `BEGIN`/`COMMIT` wrapping any of it. A crash or thrown error partway "
        "through (e.g. after donor_stats is updated but before the event_stream row lands) leaves "
        "projections and the event log inconsistent with no recovery path. Worse: `backend/src/services/"
        "indexerService.js`'s `handleDonation()` (line ~92) checks out its own `client` and wraps the whole "
        "thing in `client.query(\"BEGIN\")` ... `client.query(\"COMMIT\")`/`ROLLBACK` — but the "
        "`execute(new RecordDonationCommand(...))` and `execute(new ApplyMatchCommand(...))` calls inside "
        "that block go through `commandBus.js`'s own module-level `pool` (a *different* connection from the "
        "pool, not the checked-out `client`), so their writes commit immediately/independently regardless "
        "of whether the outer `client` transaction ever commits. The outer BEGIN/COMMIT/ROLLBACK here is "
        "decorative — it looks transactional but provides zero real atomicity, and a failure partway (e.g. "
        "RecordDonation succeeds, a later ApplyMatch throws) leaves already-committed donation data with no "
        "actual rollback despite the ROLLBACK call executing."
    ),
    approach=(
        "Give command handlers (and the aggregate-store/event-append helpers they call) the ability to "
        "accept an injectable client/transaction, so callers that need multi-command atomicity (like "
        "indexerService.js's donation + match-application flow) can genuinely wrap everything in one real "
        "transaction, and callers that don't need it aren't forced into one."
    ),
    acceptance=[
        "commandBus.js handlers accept an optional client parameter and use it for all their queries instead of always grabbing from the shared pool.",
        "indexerService.js's handleDonation passes its checked-out client through, and a test proves a mid-sequence failure genuinely rolls back everything (event_stream insert AND aggregate updates).",
        "donations.js's route handler (single-command case) is audited for whether it needs the same treatment.",
        "No regression to existing donation-recording/matching behavior or its test suite.",
    ],
    files=["backend/src/eventSourcing/commandBus.js", "backend/src/services/indexerService.js"],
),

dict(
    area="Backend",
    title="The donation-matching hot wallet is a single plaintext env-var secret key with no HSM, circuit breaker, or hard cap",
    security=True,
    summary="submitMatchingPayment loads MATCHER_SECRET_KEY from process.env and signs arbitrary matching payments in-process, with no key management, no rate limiting beyond a soft DB-tracked cap, and no circuit breaker if something goes wrong.",
    details=(
        "`backend/src/services/turrets.js`'s `submitMatchingPayment()` (line ~152) reads `process.env."
        "MATCHER_SECRET_KEY` and calls `transaction.sign(Keypair.fromSecret(matcherSecret))` directly, "
        "in-process, with no HSM/KMS integration, no multi-sig, and no hardware isolation — this is a "
        "hot-wallet pattern where compromising the backend process (or the environment it runs in) means "
        "immediately compromising the ability to drain the matcher account. The only spending control is a "
        "soft, application-level `cap_xlm` tracked in the `donation_matches` table (checked and updated via "
        "separate, non-atomic queries — see the companion idempotency issue), not any on-chain or "
        "cryptographic limit. There is no circuit breaker (e.g. auto-halt matching after N failed "
        "submissions, or after total spend in a time window exceeds a sanity threshold) if a bug (like the "
        "one described in the companion idempotency issue) or a compromised trigger source causes runaway "
        "signing."
    ),
    approach=(
        "At minimum, add a circuit breaker (spend-rate limiting independent of the DB cap, auto-disable on "
        "anomalous failure/volume patterns) and alerting. Longer-term, move key custody to a proper secret "
        "manager/HSM and consider requiring a second signer for matching payments above a threshold."
    ),
    acceptance=[
        "A circuit breaker halts automated matching-payment signing after a defined anomaly threshold (failure rate or spend velocity) and alerts an operator.",
        "MATCHER_SECRET_KEY is sourced from a proper secret manager rather than a plaintext env var, or a documented interim mitigation is in place.",
        "A runbook exists for \"the matcher key may be compromised\" (see the related cross-cutting incident-response issue).",
        "Existing matching-payment tests continue to pass with the circuit breaker in a non-tripped state.",
    ],
    files=["backend/src/services/turrets.js"],
),

dict(
    area="Backend",
    title="Donation-matching has no idempotency check on transaction_hash — at-least-once webhook delivery can trigger duplicate matching payments",
    security=True,
    summary="matchDonationTxFunction never checks whether a given payment's transaction_hash has already been processed before signing and submitting matching payments for it, risking double-matching on retried/duplicate webhook deliveries.",
    details=(
        "`matchDonationTxFunction(payment)` (backend/src/services/turrets.js, line ~29) goes straight from "
        "parsing the incoming payment fields to querying active `donation_matches` and submitting matching "
        "payments — there is no check anywhere at the top of the function for \"have I already processed "
        "this `transaction_hash`\". Turret/webhook-style delivery mechanisms are commonly at-least-once "
        "(network retries, redelivery on timeout), and if this function is invoked twice for the same "
        "underlying donation, it will happily submit matching payments a second time (bounded only by the "
        "soft `cap_xlm` remaining check, which itself isn't atomic with the payment submission — see the "
        "companion hot-wallet issue), draining the matcher's funds and double-recording matched donations "
        "in the `donations` table with no unique constraint visible on `transaction_hash` in the insert "
        "path shown at line ~112."
    ),
    approach=(
        "Add an idempotency check (e.g. a unique constraint on transaction_hash in the donations/matching "
        "table, or an explicit \"already processed\" lookup) at the very top of matchDonationTxFunction, "
        "before any matching logic runs."
    ),
    acceptance=[
        "matchDonationTxFunction is a provable no-op on a second invocation for the same transaction_hash.",
        "A test simulates the same payment payload processed twice and asserts only one set of matching payments is submitted.",
        "A database-level unique constraint backs the idempotency check (not just an application-level guard, which can itself race).",
    ],
    files=["backend/src/services/turrets.js"],
),

dict(
    area="Backend",
    title="Indexer always resumes streaming from \"now\" after every restart — donations during downtime are permanently missed",
    summary="lastProcessedLedger is tracked in memory and exposed via getStatus(), but is never persisted or used to resume the Horizon operations stream, which always starts from .cursor(\"now\") on startup.",
    details=(
        "`startIndexer()` (backend/src/services/indexerService.js, line ~41) calls `stellarServer.operations()"
        ".cursor(\"now\").stream({...})` unconditionally on every start. `lastProcessedLedger` is updated on "
        "every processed operation (line ~61: `lastProcessedLedger = op.ledger_attr`) and read back out by "
        "`getStatus()` (line ~183) for the health endpoint, but it is never written to the database and "
        "never used to construct the stream's starting cursor. This means any deploy, crash, or restart of "
        "the backend causes the indexer to silently skip every donation transaction that was broadcast to "
        "Horizon during the downtime window — those donations simply never get recorded, matched, or "
        "reflected in any donor's stats, with no error, no alert, and no reconciliation path."
    ),
    approach=(
        "Persist the last successfully processed ledger/cursor to the database after each operation (or "
        "periodically/batched for performance), and on startup, resume the stream from that persisted "
        "cursor instead of \"now\" (falling back to \"now\" only on a genuine first-ever start)."
    ),
    acceptance=[
        "The indexer persists its processing cursor durably (survives process restart).",
        "On startup, the stream resumes from the persisted cursor, not unconditionally from \"now\".",
        "A test/simulation proves a donation broadcast during a simulated downtime window is picked up on the next startup.",
        "getStatus() continues to expose the current cursor for observability.",
    ],
    files=["backend/src/services/indexerService.js"],
),

dict(
    area="Backend",
    title="Push notifications never check Expo delivery receipts or prune invalid device tokens",
    summary="sendUpdatePushNotifications treats a ticket returned by sendPushNotificationsAsync as delivery confirmation, but Expo's own documented model requires a separate receipt-checking pass — DeviceNotRegistered tokens accumulate forever.",
    details=(
        "`sendUpdatePushNotifications()` (backend/src/services/push.js, line ~14) sends chunked push "
        "messages via `expo.sendPushNotificationsAsync(chunk)` and only logs the ticket count — it never "
        "calls Expo's documented follow-up, `getPushNotificationReceiptsAsync`, and never inspects "
        "individual ticket/receipt `status`/`details.error` fields. Per Expo's own integration guidance, a "
        "successful ticket only means \"accepted for delivery attempt\", not \"delivered\" — a `Device"
        "NotRegistered` error (app uninstalled, token rotated) only surfaces in the receipt, which this "
        "code never fetches. As a result, `device_tokens` accumulates dead tokens indefinitely (degrading "
        "send performance/cost over time) and donors who stopped receiving notifications (per the app's own "
        "advertised feature) have no way for the platform to even detect it, let alone react."
    ),
    approach=(
        "Add a receipt-checking pass (immediately or on a delayed follow-up job, per Expo's guidance) that "
        "inspects each ticket's eventual receipt and removes/deactivates device_tokens rows that come back "
        "DeviceNotRegistered."
    ),
    acceptance=[
        "Push sends are followed by a receipt-checking step that inspects per-message delivery status.",
        "device_tokens rows with a DeviceNotRegistered receipt are pruned/deactivated.",
        "A test simulates a receipt indicating failure and asserts the corresponding token is removed.",
        "Existing successful-send behavior is unchanged.",
    ],
    files=["backend/src/services/push.js"],
),

dict(
    area="Backend",
    title="Rate limiting uses express-rate-limit's default in-memory store — the effective limit scales with replica count",
    summary="createRateLimiter (used for admin login, donation POST, and profile POST) has no shared store configured, so each backend pod counts requests independently; with 2 replicas today and autoscaling planned, brute-force protection on admin login weakens as capacity grows.",
    details=(
        "`backend/src/middleware/rateLimiter.js`'s `createRateLimiter()` constructs `rateLimit({ windowMs, "
        "max, ... })` with no `store` option, so `express-rate-limit` falls back to its default in-memory "
        "store — counters live per Node.js process, not shared across instances. `k8s/backend.yaml` already "
        "runs `replicas: 2`, and a companion infra issue proposes adding a Horizontal Pod Autoscaler for "
        "backend — as replica count grows, an attacker distributing requests across pods (which a load "
        "balancer will do naturally) faces an effective rate limit of `max * replica_count`, not `max`. "
        "This is most concerning for `admin.js`'s `loginLimiter = createRateLimiter(10, 15)` (10 requests "
        "per 15 minutes, intended to slow brute-forcing the admin password), which under N replicas "
        "actually allows `10 * N` attempts in the same window."
    ),
    approach=(
        "Configure a shared store (Redis, or the existing Postgres instance via a rate-limiting table/"
        "extension) for express-rate-limit so limits are enforced cluster-wide regardless of which pod "
        "handles a given request."
    ),
    acceptance=[
        "Rate limiters share state across all backend replicas (verified with a test or manual multi-instance simulation).",
        "Admin login rate limiting is provably 10 requests per 15 minutes cluster-wide, not per-pod.",
        "No significant added latency to the request hot path from the shared store.",
    ],
    files=["backend/src/middleware/rateLimiter.js", "backend/src/routes/admin.js"],
),

dict(
    area="Backend",
    title="No versioned database migration system — schema.sql is one monolithic file re-run on every boot, with no rollback or change tracking",
    summary="runMigrations() reads and executes the entirety of schema.sql on every server start; there's no migrations table, no incremental up/down scripts, and no safe path for evolving a live production schema.",
    details=(
        "`backend/src/db/migrate.js`'s `runMigrations()` (line ~7) reads all 226 lines of `backend/src/db/"
        "schema.sql` and executes it wholesale inside a transaction, every time the server starts — there "
        "is no `schema_migrations` tracking table, no numbered/timestamped migration files, and no rollback "
        "capability. Evolving the schema safely (e.g. adding a NOT NULL column to a table with existing "
        "production rows, per this project's own CI-fixing conventions this session) requires hand-editing "
        "the single schema.sql and hoping its apparent idempotency (presumably via CREATE TABLE IF NOT "
        "EXISTS-style guards) doesn't conflict with or silently no-op against already-existing production "
        "data in an unintended way. There's no way to see what changed between deployments, no way to "
        "revert a bad schema change, and no per-change audit trail."
    ),
    approach=(
        "Introduce a real migration tool (e.g. node-pg-migrate, or a hand-rolled numbered-migrations runner "
        "with a tracking table) and split schema.sql into an initial migration plus a path for all future "
        "changes to go through versioned, individually-reviewable migration files."
    ),
    acceptance=[
        "A migrations table tracks which migrations have been applied.",
        "schema.sql is decomposed into an initial baseline migration; a documented process exists for adding new ones.",
        "A test/CI step verifies migrations apply cleanly to a fresh database and are idempotent against a partially-migrated one.",
        "A rollback path exists for at least the most recent migration.",
    ],
    files=["backend/src/db/migrate.js", "backend/src/db/schema.sql"],
),

dict(
    area="Backend",
    title="Rate-limiting coverage is inconsistent — most mutating endpoints rely solely on the generic global limiter",
    summary="Only admin login, donation POST, and profile POST have endpoint-specific rate limits; ratings, subscriptions, jobs, updates, and notifications mutating routes have no dedicated limiter, relying only on the app-wide 150-requests/15-minutes limit.",
    details=(
        "`grep -n \"createRateLimiter\" backend/src/routes/*.js` shows exactly three routes with a dedicated "
        "limiter: `profiles.js` (POST, 20/1min), `admin.js` (login, 10/15min), `donations.js` (POST, "
        "10/1min). `backend/src/server.js` applies one generic `rateLimit({ windowMs: 15*60*1000, max: 150 "
        "})` app-wide (line ~60) as the only protection for every other mutating endpoint — `POST /api/v1/"
        "ratings` (spammable review-bombing), `POST/DELETE /api/v1/notifications/follow`/`unfollow` "
        "(enumeration/spam), `POST /api/v1/subscriptions`, `POST /api/v1/jobs`, and `POST /api/v1/updates` "
        "all share the same coarse, IP-wide budget as every GET request on the entire API, with nothing "
        "specific to their individual abuse profiles."
    ),
    approach=(
        "Audit each mutating endpoint for its realistic abuse profile and add an appropriately-scoped "
        "dedicated limiter (e.g. ratings should probably be tightly limited per donor address, not just "
        "IP, to prevent review-bombing a single project)."
    ),
    acceptance=[
        "Every mutating (POST/PATCH/DELETE) endpoint has a limiter appropriate to its abuse profile, not just the generic global one.",
        "Rating submission specifically is rate-limited in a way that resists both IP-based and identity-based spam.",
        "Tests cover at least one previously-unprotected endpoint hitting its new limit.",
    ],
    files=["backend/src/server.js", "backend/src/routes/ratings.js", "backend/src/routes/notifications.js", "backend/src/routes/subscriptions.js"],
),

dict(
    area="Backend",
    title="15 known high/critical npm vulnerabilities with no CI gate enforcing they get fixed",
    summary="npm audit currently reports 15 vulnerabilities (10 high) in backend and 16 (1 critical, 14 high) in frontend; Dependabot is configured but nothing in CI fails a build or blocks a merge when high/critical issues are outstanding.",
    details=(
        "Running `npm audit --json` in both `backend/` and `frontend/` this session reported real, current "
        "counts: backend `{low: 3, moderate: 2, high: 10, critical: 0, total: 15}`, frontend `{moderate: 1, "
        "high: 14, critical: 1, total: 16}`. `.github/dependabot.yml` is configured for npm across backend/"
        "frontend/mobile/extension, cargo for contracts, and docker for backend/frontend — but there is no "
        "`gomod` entry for `scheduler/` (the Go service has zero automated dependency-update coverage), and "
        "more importantly, none of `.github/workflows/*.yml` runs `npm audit` (or equivalent) as a CI gate "
        "— so even with Dependabot opening PRs, there's no automated pressure ensuring high/critical "
        "findings actually get merged and fixed, and the counts above show that pressure is currently "
        "absent in practice."
    ),
    approach=(
        "Add an `npm audit --audit-level=high` (or equivalent, e.g. `pnpm audit`, Snyk) CI step that fails "
        "the build on new high/critical findings, add a `gomod` Dependabot entry for scheduler/, and "
        "triage/fix the current 15+16 outstanding vulnerabilities."
    ),
    acceptance=[
        "CI fails (or at minimum clearly flags) on new high/critical npm vulnerabilities in backend and frontend.",
        "Dependabot covers scheduler/'s go.mod.",
        "The currently-known high/critical vulnerabilities are triaged: fixed, or explicitly documented as accepted risk with rationale.",
    ],
    files=[".github/dependabot.yml", ".github/workflows/ci.yml", "backend/package.json", "frontend/package.json"],
),

dict(
    area="Backend",
    title="eventSourcing/commandBus.js has zero dedicated unit tests despite being the most architecturally central module",
    summary="commandBus.js implements every write path in the platform (donations, matches, project status, milestones, escrow release, match offers) via six command handlers, none of which has a commandBus.test.js covering it directly.",
    details=(
        "`find backend/src -iname \"*.test.js\"` lists test files for routes, middleware, scripts, services, "
        "and utils — but no `commandBus.test.js` exists. Every write in the event-sourcing system funnels "
        "through `execute()` in `backend/src/eventSourcing/commandBus.js`, which is exactly the code "
        "implicated in two other issues from this same audit (the false-atomicity/no-transaction issue and "
        "the ON CONFLICT/duplication issue) — bugs that a focused unit-test suite exercising each handler's "
        "success, validation-failure, and duplicate/idempotency paths directly (with a mocked or test "
        "database) would have had a real chance of catching, rather than relying entirely on the higher-"
        "level route tests (`donations.test.js`, etc.) to exercise this layer indirectly."
    ),
    approach=(
        "Write commandBus.test.js covering each of the six command handlers: happy path, validation "
        "failure, duplicate/idempotency detection, and (once the transactional-integrity issue is fixed) "
        "partial-failure rollback behavior."
    ),
    acceptance=[
        "commandBus.test.js exists and exercises all six command handlers.",
        "Each handler's validation-error, duplicate-detection, and success paths are covered.",
        "Coverage for eventSourcing/commandBus.js is meaningfully above its current (near-zero, per this session's coverage report showing single-digit percentages for this file) baseline.",
    ],
    files=["backend/src/eventSourcing/commandBus.js"],
),

dict(
    area="Backend",
    title="AI summary generation jobs that exhaust retries vanish with no operator visibility or alerting",
    summary="pg-boss jobs in summaryQueue.js retry up to 3 times, but a permanently-failing job (API outage, content-policy rejection) has no dead-letter handling, metric, or alert — it just silently disappears into pg-boss's failed state.",
    details=(
        "`backend/src/services/summaryQueue.js`'s worker (line ~35) throws on any non-`MISSING_API_KEY` "
        "error so \"pg-boss will retry according to retryLimit\" (the code's own comment), and `enqueueAI"
        "Summary` sends jobs with `{ retryLimit: 3, retryDelay: 10 }`. There is no `onComplete`/failure-"
        "state subscription, no metric emitted, and no admin-facing surface showing \"summary generation "
        "permanently failed for project X\" — after 3 retries, a persistently-failing job (e.g. a project "
        "description that trips Claude's content policy every time, or a sustained Anthropic API outage) "
        "just sits in pg-boss's internal failed-jobs table with zero operator visibility short of querying "
        "it directly, and no way for a project admin to see the failure or manually retry from the UI."
    ),
    approach=(
        "Subscribe to pg-boss's failure/dead-letter events, emit a metric/log alert, and surface failed "
        "summary-generation attempts in the admin UI with a manual retry action."
    ),
    acceptance=[
        "A permanently-failed summary job is visible via logs/metrics distinct from a normal retry-in-progress state.",
        "An alerting hook exists for repeated summary-generation failures.",
        "A project admin can see and manually retry a failed summary generation from the admin UI.",
    ],
    files=["backend/src/services/summaryQueue.js"],
),

dict(
    area="Backend",
    title="No request-schema validation library — every route hand-rolls its own inconsistent validation",
    summary="grep for Joi/Zod/Yup/Ajv/express-validator across the backend returns nothing; every route implements its own ad-hoc regex/manual field checks, with no shared, declarative source of truth for request shapes.",
    details=(
        "Across `backend/src/routes/*.js`, request validation is entirely hand-written per route: some "
        "routes carefully validate every field (e.g. `donations.js`'s regex-based Stellar key/tx-hash "
        "checks), others barely validate at all (per the CRITICAL status-update authorization issue found "
        "in this same audit, `projects.js`'s status route doesn't even validate `adminAddress` is present "
        "in a meaningful way before using it). There's no shared schema library, no declarative request-"
        "shape definitions, and — notably — `docs/openapi.yml` exists as a hand-maintained spec that "
        "nothing actually validates incoming requests against, so the documented API contract and the "
        "real implementation can silently drift (this session already found two real drifts: the /api/v1 "
        "versioning gap and a response-envelope-unwrapping bug in the frontend)."
    ),
    approach=(
        "Introduce a schema-validation library (Zod is a natural fit given the TypeScript frontend could "
        "eventually share types) and incrementally migrate routes to declarative request validation, "
        "ideally generating or validating against docs/openapi.yml so the two can't drift silently."
    ),
    acceptance=[
        "A schema-validation library is adopted and used for at least the highest-risk mutating routes (donations, project status, admin actions).",
        "Validation logic is declarative and centrally reviewable, not scattered per-route regex.",
        "A documented plan exists for migrating remaining routes incrementally.",
    ],
    files=["backend/src/routes", "docs/openapi.yml"],
),

dict(
    area="Backend",
    title="No SIGTERM handler — only SIGINT is handled, so every Kubernetes-driven pod termination is abrupt",
    summary="server.js only registers process.on(\"SIGINT\", ...) for graceful shutdown; Kubernetes sends SIGTERM (not SIGINT) to terminate pods during rolling updates, scale-down, or eviction, so the Node process is currently killed abruptly on every one of those events.",
    details=(
        "`backend/src/server.js` (line ~134) registers exactly one shutdown handler: `process.on(\"SIGINT\", "
        "async () => { await shutdownEventSourcing(); process.exit(0); })` — useful for local Ctrl+C, but "
        "Kubernetes sends `SIGTERM` (with a grace period before a hard `SIGKILL`) to terminate pods during "
        "rolling deploys, HPA scale-down, or node drains — exactly the events the companion infra issues "
        "about adding HPA/PDB support are designed to make more frequent. With no `SIGTERM` handler, the "
        "process currently has no chance to drain in-flight HTTP requests, close the Postgres pool cleanly, "
        "or gracefully stop the event-sourcing scheduler/Horizon indexer stream before being killed — "
        "in-flight donations could be interrupted mid-request, and the indexer's already-fragile lack of "
        "cursor persistence (see the companion indexer issue) means an abrupt kill during active streaming "
        "is exactly when data loss is most likely."
    ),
    approach=(
        "Add a SIGTERM handler mirroring (or sharing implementation with) the existing SIGINT one: stop "
        "accepting new connections, drain in-flight requests within a bounded timeout, shut down the event-"
        "sourcing scheduler/indexer cleanly, close the DB pool, then exit."
    ),
    acceptance=[
        "A SIGTERM handler performs graceful shutdown: stop accepting new connections, drain in-flight requests (bounded timeout), close DB pool, exit.",
        "A test or manual verification confirms an in-flight request completes successfully when SIGTERM arrives mid-request.",
        "k8s manifests' terminationGracePeriodSeconds is reviewed/set consistently with the drain timeout chosen here.",
    ],
    files=["backend/src/server.js"],
),


# ═══════════════════════════════════════════════════════════════════════════
# FRONTEND (Next.js) — 12
# ═══════════════════════════════════════════════════════════════════════════

dict(
    area="Frontend",
    title="isValidStellarAddress uses a naive regex instead of StrKey checksum validation — proven to cause real bugs",
    summary="lib/stellar.ts validates Stellar addresses with /^G[A-Z0-9]{55}$/, which accepts checksum-invalid strings that pass the length/charset check but fail Stellar's actual StrKey validation, and this exact class of bug already broke this session's own e2e test fixtures.",
    details=(
        "`isValidStellarAddress(a: string): boolean { return /^G[A-Z0-9]{55}$/.test(a); }` (frontend/lib/"
        "stellar.ts, line ~414) checks shape only, not the embedded CRC16 checksum StrKey actually "
        "requires. `@stellar/stellar-sdk`'s `StrKey.isValidEd25519PublicKey()` does full validation and is "
        "already a project dependency. This isn't theoretical: during this session's own CI-fixing work, "
        "`e2e/donation-rollback.spec.ts`'s `MOCK_WALLET` fixture (`GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKI"
        "N2ER7LBNVKOCCWN`) passed this exact regex but failed `StrKey.isValidEd25519PublicKey()`, causing "
        "the Stellar SDK to throw \"destination is invalid\" deep inside transaction building — a confusing, "
        "hard-to-diagnose failure instead of a clean, immediate validation error at the point of input. Any "
        "real user who fat-fingers a wallet address in a way that happens to match the regex but corrupts "
        "the checksum hits the same confusing failure mode instead of clear, immediate feedback."
    ),
    approach=(
        "Replace the regex with `StrKey.isValidEd25519PublicKey()` (or an equivalent full-checksum check) "
        "everywhere address validation happens in the frontend."
    ),
    acceptance=[
        "isValidStellarAddress (and any other regex-only address checks in the frontend) uses real StrKey checksum validation.",
        "A test proves a checksum-invalid but regex-matching string is correctly rejected.",
        "Error messaging for an invalid address is clear and immediate, not a downstream SDK exception.",
    ],
    files=["frontend/lib/stellar.ts"],
),

dict(
    area="Frontend",
    title="useDonationSocket has no reconnect-triggered backfill — donation events broadcast during a WebSocket drop are permanently missed",
    summary="The hook only subscribes to live \"donation_event\" broadcasts; if the socket disconnects (network blip, tab backgrounding, server restart, or the WebSocket-CSP gap fixed elsewhere this session) and reconnects, nothing fetches what was missed in between.",
    details=(
        "`hooks/useDonationSocket.ts` does `socket.on(\"donation_event\", handleEvent)` and nothing else — "
        "there is no listener for Socket.IO's `reconnect` event, and no follow-up fetch of donations that "
        "occurred during the disconnected window. Live-updating UI (the donation feed, real-time raised-"
        "amount ticker) will simply be missing any donation broadcast while the client was disconnected, "
        "with no indication to the user that data might be stale/incomplete. `lib/socket.ts`'s singleton "
        "also connects with `transports: [\"websocket\"]` only — no polling fallback if WebSocket is ever "
        "blocked (this session found and fixed one real CSP gap that silently broke exactly this "
        "connection in production; there's no guarantee it's the last)."
    ),
    approach=(
        "Add a `socket.on(\"reconnect\", ...)` handler that re-fetches donations since the last known event "
        "timestamp for the active project(s), and add a documented fallback transport (`polling`) so a "
        "future connect-src/CSP or proxy issue degrades gracefully instead of silently losing all live "
        "updates. This requires a backend \"donations since timestamp\" endpoint if one doesn't already "
        "cleanly exist."
    ),
    acceptance=[
        "On reconnect, the client fetches and reconciles any donation events missed during the disconnected window.",
        "A test simulates a disconnect/reconnect cycle and proves missed events are backfilled.",
        "Socket.IO transport includes a polling fallback so WebSocket-specific blocking degrades gracefully rather than silently.",
    ],
    files=["frontend/hooks/useDonationSocket.ts", "frontend/lib/socket.ts", "backend/src/routes/donations.js"],
),

dict(
    area="Frontend",
    title="SSR + localStorage-initialized i18n state risks a hydration mismatch for non-English/RTL returning visitors",
    summary="I18nProvider's useState initializer reads localStorage for a saved locale, but the app now always server-renders (per this session's forced-SSR fix for the CSP nonce) — a returning Arabic/Spanish user's server-rendered markup (always \"en\") can mismatch the client's freshly-computed locale on the very first hydrating render.",
    details=(
        "`I18nProvider`'s `useState(() => { if (typeof window !== \"undefined\") { const stored = "
        "localStorage.getItem(\"locale\"); if (stored === \"en\"||\"es\"||\"ar\") return stored; } return "
        "\"en\"; })` (frontend/lib/i18n.tsx, line ~93) computes the initial locale differently on server "
        "(always \"en\", no `window`) vs. client (reads localStorage). Since `pages/_app.tsx` now forces "
        "every page through `getInitialProps` (added this session specifically so `_document.tsx` can "
        "thread a per-request CSP nonce), every page is genuinely server-rendered first. React's hydration "
        "model calls the client's lazy initializer during the hydrating render specifically to detect "
        "mismatches against server-rendered markup — if a returning visitor previously chose \"ar\", the "
        "client's first hydrating render computes \"ar\" (RTL, Arabic strings) while the actual DOM was "
        "server-rendered as \"en\" (LTR, English strings), which is a textbook Next.js hydration-mismatch "
        "trigger, and the `useEffect` that syncs `document.documentElement.dir`/`lang` (line ~103) only "
        "runs *after* hydration completes, not before."
    ),
    approach=(
        "Thread the locale preference through a mechanism SSR can actually see (a cookie, read server-side "
        "in `getInitialProps`/middleware) instead of `localStorage`, which is fundamentally invisible to "
        "the server render."
    ),
    acceptance=[
        "A returning visitor's saved locale renders correctly on the very first server-rendered paint, not just after client hydration.",
        "No React hydration-mismatch warnings occur for a non-English/RTL locale in dev mode.",
        "localStorage-based locale persistence is replaced or supplemented with an SSR-visible mechanism (cookie).",
        "Existing locale-switching behavior (in-session, via the UI toggle) is unchanged.",
    ],
    files=["frontend/lib/i18n.tsx", "frontend/pages/_app.tsx", "frontend/middleware.ts"],
),

dict(
    area="Frontend",
    title="Donation amount handling uses floating-point arithmetic throughout instead of a fixed-point type",
    summary="parseFloat/toFixed(7) are used across DonateForm, monthlyGiving.ts, and balance comparisons for values that ultimately become Stellar's fixed-point 7-decimal stroop amounts — the wrong primitive for money, with the same risk already flagged independently in the mobile app's codebase.",
    details=(
        "`components/DonateForm.tsx` and `lib/monthlyGiving.ts` parse and format donation amounts via "
        "`parseFloat(...)`/`.toFixed(7)` at multiple call sites, and balance-sufficiency checks compare "
        "these IEEE-754 doubles directly. Values near the 7-decimal precision boundary can round or compare "
        "incorrectly relative to what Horizon's fixed-point stroop-based validation actually does, so a "
        "preflight check can pass/fail inconsistently with the real on-chain submission outcome. This is "
        "the same architectural gap independently identified in the mobile codebase's amount-handling code "
        "this session — both clients share the underlying risk, with no shared, precision-safe amount "
        "utility between them."
    ),
    approach=(
        "Introduce a shared, fixed-point amount utility (stroops-as-integers, or a decimal library) used "
        "consistently for parsing, comparing, and formatting donation amounts, replacing ad-hoc parseFloat/"
        "toFixed call sites in donation-critical paths."
    ),
    acceptance=[
        "A shared amount-handling utility replaces direct parseFloat/toFixed usage in donation-critical code paths.",
        "Balance-sufficiency comparisons are proven correct at precision boundaries (property-based test recommended, e.g. with fast-check, already a dev dependency).",
        "No change to the existing donation submission API contract (amounts still serialize the same way to the backend).",
    ],
    files=["frontend/components/DonateForm.tsx", "frontend/lib/monthlyGiving.ts"],
),

dict(
    area="Frontend",
    title="XLM/USD price is fetched once on mount and never refreshed, with no staleness indicator",
    summary="PriceProvider fetches CoinGecko's XLM/USD price a single time when the app loads and never re-fetches or polls, so a long-lived session shows an increasingly wrong USD equivalent with no signal to the user that it might be stale.",
    details=(
        "`lib/priceContext.tsx`'s `PriceProvider` runs its `fetch(\"https://api.coingecko.com/...\")` inside "
        "a `useEffect` with an empty dependency array — it fires exactly once, on mount, for the lifetime of "
        "the app/tab. A donor who leaves a tab open for hours (browsing projects, reading updates before "
        "deciding to donate) sees a USD-equivalent figure that can be significantly stale by the time they "
        "actually donate, with zero indication in the UI that the conversion rate might be outdated."
    ),
    approach=(
        "Add periodic refresh (e.g. every few minutes) with reasonable backoff/rate-limit awareness for "
        "CoinGecko's free tier, and consider surfacing a subtle \"as of Xm ago\" indicator near USD-"
        "equivalent figures."
    ),
    acceptance=[
        "XLM/USD price refreshes periodically during a long-lived session, not just once on mount.",
        "Refresh respects CoinGecko's free-tier rate limits and fails silently/gracefully as the existing single-fetch does.",
        "A staleness indicator (or at minimum, a documented acceptable staleness window) is present near USD-equivalent UI.",
    ],
    files=["frontend/lib/priceContext.tsx"],
),

dict(
    area="Frontend",
    title="Socket.IO client singleton has no disconnect/cleanup path and no transport fallback",
    summary="getSocket() lazily creates one module-level Socket.IO connection for the app's lifetime with transports locked to [\"websocket\"] only — there's no exposed disconnect(), and no polling fallback if the WebSocket upgrade is ever blocked.",
    details=(
        "`lib/socket.ts`'s `getSocket()` (line ~9) creates and caches a single `Socket` instance the first "
        "time it's called, with `transports: [\"websocket\"]` and no exported way to disconnect/reset it. "
        "This session found and fixed a real production bug where this exact connection was silently "
        "CSP-blocked (connect-src only allowlisted the http(s) origin, not the matching ws(s) one) — with "
        "`transports` locked to WebSocket-only, there's no automatic fallback to long-polling if a "
        "*different* future network/proxy/CSP constraint blocks WebSocket upgrades specifically, and "
        "consumers like `useDonationSocket` have no way to detect \"the socket has never successfully "
        "connected\" versus \"connected but currently idle\"."
    ),
    approach=(
        "Allow a polling fallback in the transports list, expose connection-state (connected/reconnecting/"
        "failed) to consumers so UI can react, and add an explicit teardown path for contexts (e.g. tests, "
        "SSR safety) that need one."
    ),
    acceptance=[
        "Socket.IO client falls back to polling if the WebSocket transport fails to connect.",
        "Connection state is observable by consuming hooks/components, not just implicit.",
        "A documented, tested disconnect/cleanup path exists.",
    ],
    files=["frontend/lib/socket.ts", "frontend/hooks/useDonationSocket.ts"],
),

dict(
    area="Frontend",
    title="useAutocomplete has no request sequencing — out-of-order network responses can render stale search results",
    summary="The debounce only delays when a new fetch starts; once two fetches are in flight (e.g. for \"o\" then \"oc\"), whichever HTTP response arrives last wins and overwrites results, even if it's for a query the user has already typed past.",
    details=(
        "`hooks/useAutocomplete.ts`'s `useEffect` debounces the *start* of each fetch via `setTimeout` (line "
        "~20), but once a fetch is in flight there is no `AbortController` and no sequence/query tag "
        "attached to the eventual response — `setResults(data)` unconditionally overwrites state with "
        "whatever arrives, regardless of whether a newer query has since superseded it. Network jitter (the "
        "response for an earlier, shorter query taking longer than a later, more specific one) can "
        "therefore leave the autocomplete dropdown showing results for a query the user has already refined "
        "away from — used by `pages/projects/index.tsx`'s project search."
    ),
    approach=(
        "Tag each fetch with the query it was issued for (or use `AbortController` to cancel superseded "
        "requests) and ignore/discard responses that don't match the current query when they resolve."
    ),
    acceptance=[
        "A response for a stale/superseded query is never rendered, even if it resolves after a newer query's response.",
        "A test simulates out-of-order resolution (older query resolves after newer one) and asserts only the newer result set renders.",
        "No regression to existing debounce timing/behavior.",
    ],
    files=["frontend/hooks/useAutocomplete.ts", "frontend/pages/projects/index.tsx"],
),

dict(
    area="Frontend",
    title="CSRF token refresh has no in-flight deduplication — concurrent mutating requests can race and cause spurious 403s",
    summary="refreshCsrfToken() is called independently by every mutating request that finds csrfToken unset, with no shared in-flight promise — several near-simultaneous requests on page load can issue redundant refresh calls and potentially race against each other's token usage.",
    details=(
        "`lib/api.ts`'s request interceptor (line ~43) does `if (!csrfToken) { await refreshCsrfToken(); }` "
        "independently for every outgoing mutating request. If several POST/PATCH/DELETE calls fire nearly "
        "simultaneously (e.g. a page that kicks off multiple mutations on load, or rapid user interaction) "
        "before any of them has resolved, each one sees `csrfToken` as still null and independently calls "
        "`refreshCsrfToken()`, issuing N redundant `GET /api/v1/csrf-token` requests instead of one. "
        "Depending on the backend's CSRF token model (csurf typically ties a single valid token to the "
        "session), the *last*-resolving refresh could overwrite `csrfToken` with a value that races against "
        "requests that already read an earlier value before it changed, risking spurious 403 CSRF failures "
        "under concurrent mutating requests."
    ),
    approach=(
        "Deduplicate concurrent refresh calls behind a single shared in-flight promise, so N simultaneous "
        "mutating requests trigger exactly one `GET /api/v1/csrf-token` and all await the same result."
    ),
    acceptance=[
        "Multiple concurrent mutating requests issued before any csrfToken exists result in exactly one refresh call.",
        "A test simulates several simultaneous mutating requests on a cold csrfToken and asserts only one token-fetch occurs and all requests succeed.",
        "No change to the existing 403-triggered re-refresh-and-retry behavior.",
    ],
    files=["frontend/lib/api.ts"],
),

dict(
    area="Frontend",
    title="Recurring-donation date math is duplicated between frontend and backend with no shared source of truth or cross-validation",
    summary="lib/monthlyGiving.ts (client-side preview) and backend/src/utils/recurringSchedule.js (server-side actual scheduling) independently implement month-length/DST-aware date arithmetic — a fix applied to one (as happened for the frontend copy in a past commit) isn't guaranteed to propagate to the other.",
    details=(
        "`frontend/lib/monthlyGiving.ts` (251 lines) and `backend/src/utils/recurringSchedule.js` (122 "
        "lines) both implement `daysInMonth`/`clampDayToMonth`-style logic for computing recurring charge "
        "dates, entirely independently in two languages. A past commit (`f962641`) fixed a documented "
        "month-length/DST edge case (Jan 31 clamping permanently degrading to the 29th/30th forever instead "
        "of restoring to 31 when a later month allows it) in the frontend copy — there is no test or CI "
        "check proving the backend copy doesn't have (or later regain, if either is modified independently) "
        "the same class of bug. For a feature whose entire purpose is telling a donor exactly when they'll "
        "be charged, a UI preview that can silently diverge from the actual backend-scheduled date is a "
        "real correctness risk with no safety net."
    ),
    approach=(
        "Either extract the date-arithmetic logic into a single shared package consumable by both (e.g. via "
        "a small shared npm workspace package), or add a cross-validation test suite that runs the same "
        "input scenarios through both implementations and asserts identical output."
    ),
    acceptance=[
        "The two implementations either share one source of truth, or a test suite proves their outputs are identical across a comprehensive set of month-length/DST/timezone edge cases.",
        "The test suite would have caught the original bug fixed in f962641 if run against a pre-fix version.",
        "CI runs this cross-validation on every change to either file.",
    ],
    files=["frontend/lib/monthlyGiving.ts", "backend/src/utils/recurringSchedule.js"],
),

dict(
    area="Frontend",
    title="A missing USDC trustline blocks donation with an error and no in-app path to fix it",
    summary="DonateForm detects trustlineMissing and throws a blocking error asking the donor to \"add a trustline\", but offers no in-app changeTrust flow — donors must leave the app entirely to establish the trustline elsewhere.",
    details=(
        "`components/DonateForm.tsx` checks USDC trustline presence via `getAssetBalance` (line ~81) and, "
        "if missing, throws `\"No USDC trustline on your account. Add a trustline to receive/send USDC.\"` "
        "(line ~155) when the donor attempts to submit — but there is no button, modal, or flow anywhere in "
        "this component (or elsewhere in the app) that builds and submits a `changeTrust` operation for "
        "them. A donor who wants to give USDC but has never held it before is fully blocked and must find a "
        "separate wallet/tool to add the trustline before they can come back and donate — a significant, "
        "avoidable conversion-killing gap for the platform's secondary supported currency."
    ),
    approach=(
        "Add an in-app \"Add USDC trustline\" action that builds, signs (via the existing Freighter "
        "integration), and submits a `changeTrust` operation, then re-checks trustline status and allows "
        "the donor to proceed."
    ),
    acceptance=[
        "A donor without a USDC trustline is offered an in-app action to establish one, not just an error message.",
        "The trustline-creation flow reuses the existing wallet-signing infrastructure (lib/wallet.ts).",
        "After successfully adding a trustline, the donor can proceed to donate USDC without leaving the app or reloading.",
    ],
    files=["frontend/components/DonateForm.tsx", "frontend/lib/stellar.ts"],
),

dict(
    area="Frontend",
    title="The leaderboard has a hardcoded top-N cutoff with no pagination or virtualization strategy beyond it",
    summary="LeaderboardTable always fetches a fixed limit (50 on the leaderboard page) with no way for a user to see beyond the cutoff, and no virtualization exists for if that limit is ever raised for a genuine full-leaderboard view.",
    details=(
        "`components/LeaderboardTable.tsx` takes a `limit` prop (default 20) and `pages/leaderboard.tsx` "
        "passes `limit={50}` — the backend route also caps at 100. There's currently no pagination, "
        "\"load more\", or infinite-scroll affordance, so a donor ranked 51st or below has no way to find "
        "their own position, and the component's flat `.map()` render has no virtualization — meaning if "
        "this cutoff is ever raised (a natural next step for a platform designed to scale, and the kind of "
        "change that's easy to make without revisiting the render strategy), performance will degrade "
        "linearly with no windowing in place."
    ),
    approach=(
        "Add pagination or infinite-scroll so donors beyond the current cutoff are reachable, and adopt a "
        "virtualization library (e.g. react-window) if/when the effective row count is raised beyond a "
        "comfortably-unvirtualized range."
    ),
    acceptance=[
        "A user can navigate beyond the current top-N cutoff to find their own rank.",
        "The render strategy is documented as safe up to a specific row count, with virtualization added before any increase past that.",
        "No regression to the existing default top-20/50 display.",
    ],
    files=["frontend/components/LeaderboardTable.tsx", "frontend/pages/leaderboard.tsx"],
),

dict(
    area="Frontend",
    title="Freighter API result handling relies on repeated ad-hoc \"handle both shapes\" any-casts instead of a validated contract",
    summary="lib/wallet.ts casts every Freighter API response to `any` and manually branches on whether the result is a string or an object, four separate times, with no runtime validation guarding against a future API version returning an unexpected shape.",
    details=(
        "`lib/wallet.ts`'s `isFreighterInstalled`, `connectWallet`, `getConnectedPublicKey`, and "
        "`signTransactionWithWallet` each do `const result: any = await someFreighterCall(); const value = "
        "typeof result === 'string' ? result : result?.someField;` — the exact same defensive pattern "
        "repeated four times, with a comment acknowledging \"Handle both string and object return types\". "
        "This suggests real uncertainty/instability in what `@stellar/freighter-api` actually returns across "
        "versions, but there's no runtime validation (e.g. a schema check) guarding against a future version "
        "returning a third, unhandled shape — it would silently fall through to `undefined`/`null` with no "
        "clear error, rather than a validated, well-typed contract with a clear failure mode when the "
        "assumption breaks."
    ),
    approach=(
        "Introduce a small runtime-validated wrapper around each Freighter API call (or pin/verify the "
        "expected response shape per the installed package version), replacing the repeated any-cast/"
        "typeof-branch pattern with one well-tested adapter."
    ),
    acceptance=[
        "A single, tested adapter normalizes Freighter API responses, replacing the four independent any-cast/typeof branches.",
        "An unexpected/unhandled response shape produces a clear, distinguishable error rather than silently becoming undefined.",
        "No behavior change for the currently-supported response shapes.",
    ],
    files=["frontend/lib/wallet.ts"],
),


# ═══════════════════════════════════════════════════════════════════════════
# MOBILE (Expo / React Native) — 12
# ═══════════════════════════════════════════════════════════════════════════

dict(
    area="Mobile",
    title="Donation transactions are always signed with Networks.TESTNET regardless of the configured Stellar network",
    security=True,
    summary="handleDonate hardcodes Networks.TESTNET as the transaction's networkPassphrase, while HORIZON_URL and STELLAR_NETWORK are independently configured via env vars — a mainnet-configured build would still sign with the testnet passphrase.",
    details=(
        "`app/donate/[id].tsx`'s `handleDonate()` builds `new TransactionBuilder(sourceAccount, { fee: "
        "'100', networkPassphrase: Networks.TESTNET, ... })` with a hardcoded constant, while `HORIZON_URL` "
        "is read from `EXPO_PUBLIC_HORIZON_URL` and `utils/stellarNetwork.ts` already exposes a correct "
        "`getExpectedNetworkPassphrase()` helper (used properly by `utils/sep7.ts`). If a build is ever "
        "configured for mainnet via env vars, transactions would still be signed with the testnet "
        "passphrase, producing a transaction that's invalid for the network it's actually being submitted "
        "to (or worse, ambiguous behavior depending on how the wallet/Horizon endpoint handles a passphrase "
        "mismatch)."
    ),
    approach=(
        "Use getExpectedNetworkPassphrase() in handleDonate instead of the hardcoded constant, and add a "
        "startup assertion preventing HORIZON_URL/STELLAR_NETWORK from silently diverging."
    ),
    acceptance=[
        "handleDonate uses getExpectedNetworkPassphrase() instead of Networks.TESTNET.",
        "A runtime check prevents HORIZON_URL and STELLAR_NETWORK from pointing at inconsistent networks.",
        "UI copy no longer hardcodes \"testnet\" language.",
        "A test verifies a mainnet-configured build signs with the public network passphrase.",
    ],
    files=["mobile/app/donate/[id].tsx", "mobile/utils/stellarNetwork.ts"],
),

dict(
    area="Mobile",
    title="Completing a queued offline donation never marks the original queue entry fulfilled, risking duplicate submission",
    summary="sync-conflicts.tsx's \"Complete now\" action navigates to the donate screen without the queue entry's identity, and nothing removes the original entry after a successful submit — inviting a second, duplicate on-chain payment.",
    details=(
        "`app/sync-conflicts.tsx`'s `handleCompleteNow` does only `router.push(/donate/${entry.projectId})` "
        "— it doesn't pass the queued entry's id, doesn't prefill amount/message, and `app/donate/[id].tsx` "
        "has no code path that removes the corresponding `QueuedDonation` from storage after a successful "
        "submit. The user must re-type the amount from memory, and the original `ready` queue entry remains "
        "indefinitely, inviting a second, duplicate donation the next time the sync-conflicts screen is "
        "visited. `donationQueue.ts` even declares a `'duplicate'` conflict reason that's never actually "
        "produced anywhere, suggesting duplicate-detection was intended but never finished."
    ),
    approach=(
        "Thread the queue-entry id through the donate flow, prefill amount/message from it, and remove (or "
        "mark completed) the originating entry atomically with a successful submit — including "
        "reconciliation for a donation that reaches Horizon but fails the backend POST."
    ),
    acceptance=[
        "Navigating from \"Complete now\" prefills amount/message from the queue entry.",
        "A successful submit removes/completes the originating queue entry atomically with the result.",
        "A donation reaching Horizon but failing the backend POST is reconciled rather than silently duplicated on next preflight.",
        "Test: enqueue → go online → mark ready → complete now → queue entry gone, no duplicate possible on repeat visits.",
    ],
    files=["mobile/app/sync-conflicts.tsx", "mobile/hooks/useDonationSync.ts", "mobile/utils/donationQueue.ts"],
),

dict(
    area="Mobile",
    title="useDeepLink bypasses qrPayload.ts's security-hardened validation entirely",
    security=True,
    summary="qrPayload.ts was built specifically to reject untrusted hosts/params after a real vulnerability, but useDeepLink.ts implements its own separate, unvalidated parser for the same greenpay:// scheme.",
    details=(
        "`utils/qrPayload.ts` explicitly rejects arbitrary hosts/params after a prior vulnerability where "
        "`?projectId=` was accepted from any host. But `hooks/useDeepLink.ts`'s `handleUrl` implements its "
        "own naive parser (`path.replace(/^\\//,'').split('/')`) and does `router.push(/donate/${param})` "
        "with zero charset/length/host validation — the two code paths handling the same `greenpay://` "
        "scheme enforce completely different trust levels, reintroducing the class of vulnerability the "
        "other module was built to close."
    ),
    approach=(
        "Route handleUrl through parseGreenPayDonationLink (or factor out a shared validator used by both "
        "the QR and deep-link paths), preserving the existing hydration-ordering guarantees in "
        "useDeepLink's own documented rationale."
    ),
    acceptance=[
        "handleUrl validates donate/<id> (and project/<id>) through the same allowlist/charset rules as parseGreenPayDonationLink.",
        "Malformed/oversized/control-character deep-link params are rejected without navigating or crashing.",
        "A regression test mirrors qrFuzz.test.ts for the deep-link path.",
        "Existing hydration-race fix behavior is preserved.",
    ],
    files=["mobile/hooks/useDeepLink.ts", "mobile/utils/qrPayload.ts"],
),

dict(
    area="Mobile",
    title="Recurring/monthly donations have no creation entry point and no execution engine",
    summary="createRecurringDonation exists in utils/recurringDonations.ts but is called from nowhere in the app, and nothing ever advances nextDueDate or actually triggers a payment when a cycle is due.",
    details=(
        "`createRecurringDonation` is referenced only within `recurringDonations.ts` and `app/recurring.tsx`'s "
        "imports — there is no button on the project or donate screens to start one, despite `recurring.tsx`'s "
        "empty-state copy claiming \"Set up a monthly donation from any project page.\" There is also no "
        "scheduler/background task that advances `nextDueDate`, decrements `remainingMonths`, or triggers a "
        "payment when due — the module is bookkeeping with no engine. Real recurring payments need a design "
        "decision given mobile background-execution limits and the app's own no-persisted-secret-keys "
        "security posture (auto-signing is off the table by design)."
    ),
    approach=(
        "Add a UI entry point, and design a trigger mechanism (server-side scheduling + push notification "
        "\"your monthly donation is due, tap to sign\") consistent with the app's stated security posture."
    ),
    acceptance=[
        "A UI entry point exists to create a RecurringDonation from the project/donate screen.",
        "A defined trigger (push notification + deep link, or server reminder) fires when nextDueDate arrives.",
        "nextDueDate/remainingMonths advance/decrement after each completed cycle; status transitions to completed at 0.",
        "Documented rationale for not auto-signing, consistent with the existing security posture.",
    ],
    files=["mobile/utils/recurringDonations.ts", "mobile/app/recurring.tsx"],
),

dict(
    area="Mobile",
    title="The donate screen's wallet-connect flow bypasses the app's own SecureStore-backed wallet system entirely",
    security=True,
    summary="donate/[id].tsx has its own local Alert.prompt-based \"connect wallet\" that accepts any typed public key validated by a bare regex (not a real StrKey checksum), never persisting to SecureStore or going through useWallet().",
    details=(
        "`app/donate/[id].tsx` maintains its own local `publicKey` state and `connectWallet()` using "
        "`Alert.prompt` with `/^G[A-Z0-9]{55}$/` — not even a checksum check — completely bypassing "
        "`getWalletPublicKey()`/`setWalletPublicKey()` and the checksum-validated `useWallet().connect()` "
        "that `WalletConnect.tsx` uses. The donate screen's connected wallet is never persisted to "
        "SecureStore, never survives app restart, and doesn't benefit from the muxed-account support "
        "already built into `stellarValidation.ts`."
    ),
    approach=(
        "Migrate donate/[id].tsx to use useWallet()/walletKeyStorage.ts as the single source of truth "
        "(per that module's own doc comment), with a migration path so users mid-donation don't lose a "
        "connected key."
    ),
    acceptance=[
        "donate/[id].tsx uses useWallet()/walletKeyStorage.ts instead of its own local state.",
        "A connected wallet persists across app restarts from the donate screen too.",
        "Public key input is validated with StrKey/isValidStellarDestination, not a hand-rolled regex.",
        "A wallet connected on the donate screen is visible in WalletConnect.tsx's badge and vice versa.",
    ],
    files=["mobile/app/donate/[id].tsx", "mobile/src/hooks/useWallet.ts", "mobile/src/components/WalletConnect.tsx"],
),

dict(
    area="Mobile",
    title="Push-notification registration functions report success even on HTTP error responses",
    summary="registerDeviceToken/followProject/unfollowProject in utils/notifications.ts never check response.ok before logging success, so a failed server-side registration is indistinguishable from a real success.",
    details=(
        "All four network functions in `utils/notifications.ts` use bare `fetch()` and never check `response."
        "ok`/status before returning `true`. A 500, 401, or malformed response is treated identically to "
        "success — a device token registration that silently failed server-side leaves the user believing "
        "they'll receive donation-update push notifications when they never will, with no retry and no way "
        "to distinguish \"permission denied\" from \"network/server error\"."
    ),
    approach=(
        "Check response.ok/status in each function and treat non-2xx as a distinguishable failure; retry "
        "registration on next app foreground rather than dropping it silently."
    ),
    acceptance=[
        "Each function checks response.ok/status and returns a distinguishable failure, not a swallowed console.error.",
        "Registration failures are retried on next app foreground rather than lost forever.",
        "\"Permission denied\" is distinguished from \"network/server error\".",
        "A test proves a 4xx/5xx response causes registerDeviceToken to return false.",
    ],
    files=["mobile/utils/notifications.ts"],
),

dict(
    area="Mobile",
    title="Offline-sync preflight makes redundant sequential Horizon calls per queued donation with no dedup, backoff, or duplicate detection",
    summary="syncNow() awaits preflightCheck() sequentially per queued entry, issuing repeat Horizon loadAccount calls for the same donor, with no rate-limit handling and no assignment of the already-defined 'duplicate' conflict reason.",
    details=(
        "`hooks/useDonationSync.ts`'s `syncNow()` loops through `pending-sync` entries awaiting "
        "`preflightCheck()` for each — with even a few queued donations to the same donor address, this "
        "issues redundant duplicate Horizon `loadAccount` calls with no dedup, no bounded concurrency, and "
        "no 429/rate-limit-specific handling (a hard rate limit looks identical to a generic network "
        "failure, leaving everything `pending-sync`). Separately, `ConflictReason` declares `'duplicate'` "
        "but `preflightCheck` never assigns it, so two queued donations to the same project never get "
        "flagged before both get manually completed."
    ),
    approach=(
        "Dedup loadAccount results per donorAddress within a sync pass, distinguish 429s from generic "
        "failures with backoff, and implement a tested duplicate-detection rule assigning conflictReason: "
        "'duplicate'."
    ),
    acceptance=[
        "loadAccount results are cached/deduped per donorAddress within a single syncNow() pass.",
        "A defined, tested duplicate-detection rule assigns 'duplicate' and sync-conflicts.tsx renders it.",
        "Horizon 429 responses are distinguished from generic failures and back off rather than hammering on every reconnect.",
        "Test with 3+ queued entries for the same donor verifies only one loadAccount call is made.",
    ],
    files=["mobile/hooks/useDonationSync.ts", "mobile/utils/donationQueue.ts"],
),

dict(
    area="Mobile",
    title="The offline donation queue's read-modify-write storage pattern has no concurrency control",
    summary="Every mutator in donationQueue.ts independently reads the full list then writes it back with no lock/versioning — concurrent enqueue/update/remove calls can silently clobber each other's writes.",
    details=(
        "Every mutator (`enqueueDonation`, `updateQueuedDonation`, `removeQueuedDonation`) in `utils/"
        "donationQueue.ts` independently does `listQueuedDonations()` then `saveQueuedDonations()` — a "
        "classic read-modify-write race with no lock. `useDonationSync.syncNow()` iterates and mutates "
        "per-entry inside a loop while the user could simultaneously enqueue a new offline donation, or "
        "call `resolve()` from sync-conflicts.tsx — either can clobber the other's write since both read "
        "the full array before either writes back."
    ),
    approach=(
        "Serialize all reads+writes through a single module-level promise chain (or implement diff/merge-"
        "based writes that only patch the touched entry rather than overwriting the full array)."
    ),
    acceptance=[
        "Concurrent enqueueDonation + updateQueuedDonation calls never lose either write (test with Promise.all).",
        "All mutators funnel through a single serialized queue or equivalent.",
        "syncNow()'s per-entry loop is proven safe against a new enqueueDonation firing mid-loop.",
        "No regression in existing donationQueue.test.ts/donationSync.test.tsx.",
    ],
    files=["mobile/utils/donationQueue.ts", "mobile/hooks/useDonationSync.ts"],
),

dict(
    area="Mobile",
    title="Donation-amount handling uses floating-point arithmetic instead of a fixed-point type",
    summary="parseFloat/toFixed(7) are used throughout donate/[id].tsx, useDonationSync.ts's fee-buffer comparison, and sync-conflicts.tsx's amount editor — the wrong primitive for values that become Stellar's fixed-point stroop amounts, mirroring the same gap independently found in the web frontend.",
    details=(
        "Amounts flow through `parseFloat(amount)`, `.toFixed(7)`, and balance comparisons like `available "
        "< required` where `required = parseFloat(entry.amountXLM) + FEE_BUFFER_XLM` across `app/donate/"
        "[id].tsx`, `useDonationSync.ts`, and `app/sync-conflicts.tsx`. IEEE-754 double arithmetic on values "
        "near the 7-decimal precision boundary can round or compare incorrectly relative to Horizon's "
        "actual fixed-point validation, so a preflight check can pass/fail inconsistently with the real "
        "on-chain outcome."
    ),
    approach=(
        "Introduce a consistent fixed-point amount utility used everywhere amounts are parsed, compared, or "
        "formatted, without breaking the .toFixed(7)-formatted strings the backend API expects."
    ),
    acceptance=[
        "A shared amount-parsing/formatting utility replaces ad-hoc parseFloat/toFixed in donation-critical paths.",
        "Preflight balance comparison is proven correct at precision boundaries.",
        "Property-based test (fast-check is already a dev dependency) fuzzing amount strings through parse→compare→format round trips.",
    ],
    files=["mobile/app/donate/[id].tsx", "mobile/hooks/useDonationSync.ts", "mobile/app/sync-conflicts.tsx"],
),

dict(
    area="Mobile",
    title="Device jailbreak/root integrity check runs once at mount with no re-check on app foreground",
    summary="useDeviceIntegrity() computes the compromised-device result exactly once via a lazy useState initializer and never re-evaluates it, including across background/foreground transitions where the underlying signal could change.",
    details=(
        "`utils/useDeviceIntegrity.ts`'s hook computes the jailbreak/root result once via `useState(() => "
        "checkDeviceIntegrity())` at `AppShell` mount and never re-runs it. `AppShell` only shows "
        "`SecurityWarningBanner` when `isCompromised && publicKey`, and since `publicKey` hydrates "
        "asynchronously from SecureStore, there's a window where an already-connected wallet on a "
        "compromised device shows no banner until hydration finishes — with no re-check on `AppState` "
        "foreground transitions despite that being exactly the signal that would catch jailbreak tooling "
        "toggled while backgrounded."
    ),
    approach=(
        "Re-run the integrity check on relevant lifecycle events (at minimum, app foreground), balanced "
        "against the documented false-positive/performance cost of over-checking, per the module's own "
        "\"advisory only\" contract."
    ),
    acceptance=[
        "Integrity check re-runs on app foreground, not only once per cold mount.",
        "Banner visibility has no hydration-order gap for already-connected wallets.",
        "No behavior change to the \"advisory only, never blocks\" contract already documented.",
        "A test simulates a background→foreground transition changing the reported integrity state.",
    ],
    files=["mobile/utils/deviceIntegrity.ts", "mobile/utils/useDeviceIntegrity.ts", "mobile/app/_layout.tsx"],
),

dict(
    area="Mobile",
    title="No Android App Links or iOS Universal Links configured despite qrPayload.ts treating https://greenpay.app links as first-class",
    summary="app.json only registers the custom greenpay:// scheme; there's no Android intentFilter autoVerify entry and no iOS associatedDomains, so the security-hardened https://greenpay.app/donate link form can never actually be opened by tapping a real link.",
    details=(
        "`qrPayload.ts` explicitly validates and accepts `https://greenpay.app/donate?projectId=...` as a "
        "supported link form (`ALLOWED_HOST = 'greenpay.app'`), but `app.json`'s Android `intentFilters` "
        "only register the `greenpay://` custom scheme, and there is no `ios.associatedDomains` entry at "
        "all. The `https://greenpay.app/...` form can only be reached by manually pasting the URL or "
        "scanning a QR code — not by tapping a real link on either platform — a platform-configuration gap "
        "contradicting the app's own security design intent."
    ),
    approach=(
        "Add Android App Links (assetlinks.json + autoVerify intent filter) and iOS Universal Links "
        "(associatedDomains + apple-app-site-association), coordinated with hosting the required well-known "
        "files on the real greenpay.app domain."
    ),
    acceptance=[
        "Android intentFilters include an https://greenpay.app/* entry with autoVerify: true backed by a valid assetlinks.json.",
        "iOS config includes associatedDomains (applinks:greenpay.app) with a valid apple-app-site-association.",
        "Tapping a real https://greenpay.app/donate?projectId=... link on both platforms opens the app directly to the donate screen through the validated qrPayload.ts path.",
        "Documented/tested fallback for devices without the app installed.",
    ],
    files=["mobile/app.json"],
),

dict(
    area="Mobile",
    title="Cached project data's staleness flag is computed but silently discarded by its only caller",
    summary="getCachedData returns { data, isStale } with a real 10-minute TTL, but app/index.tsx's offline fallback discards isStale entirely, showing potentially days-old fundraising data with no indication it's outdated.",
    details=(
        "`utils/cache.ts`'s `getCachedData<T>()` computes a real `isStale` flag, but the only caller — `app/"
        "index.tsx`'s `loadProjects()` catch block — does `setProjects(cached.data)` and discards `cached."
        "isStale` entirely. A user offline for days sees week-old goal/raised amounts and donor counts with "
        "no \"last updated\" indicator, which is materially misleading for a donation platform showing "
        "fundraising progress."
    ),
    approach=(
        "Surface isStale in the UI (a \"showing cached data from X ago\" banner), establish a shared "
        "caching hook/pattern so future screens can't silently drop it, and proactively refresh stale "
        "caches on the same reconnect signal useDonationSync already listens for."
    ),
    acceptance=[
        "isStale is surfaced in the UI wherever getCachedData is used.",
        "A shared caching hook/pattern prevents future screens from silently dropping isStale again.",
        "Cached data is proactively refreshed on the existing reconnect signal, not just on manual pull-to-refresh.",
        "A test asserts stale cached data renders a visible staleness indicator.",
    ],
    files=["mobile/utils/cache.ts", "mobile/app/index.tsx"],
),


# ═══════════════════════════════════════════════════════════════════════════
# INFRA (K8s / Helm / CI/CD) — 10
# ═══════════════════════════════════════════════════════════════════════════

dict(
    area="Infra",
    title="scripts/backup-db.sh calls upload_to_s3/upload_to_gcs before they're defined — nightly production backups fail every run",
    security=True,
    summary="The storage-type dispatch case statement calls upload_to_s3()/upload_to_gcs() before those functions are defined later in the same file; with `set -euo pipefail`, the script exits with \"command not found\" right after the dump succeeds, so uploads never happen.",
    details=(
        "In `scripts/backup-db.sh`, the `case \"$STORAGE_TYPE\" in s3) upload_to_s3 ;; ...` dispatch appears "
        "before `upload_to_s3()` and `upload_to_gcs()` are defined later in the file. Since bash executes "
        "top-to-bottom with no `main()` wrapper or sourcing indirection, this hits \"command not found\", "
        "and `set -euo pipefail` causes immediate exit. `.github/workflows/database-backup.yml` runs this "
        "nightly and only alerts via a generated GitHub issue on failure — meaning every run has plausibly "
        "failed silently after `pg_dump`/`gzip` succeed locally, with the actual disaster-recovery upload "
        "step never happening, for a platform handling real funds."
    ),
    approach=(
        "Restructure the script into a proper main() invoked at the bottom (after all function definitions), "
        "add a post-upload integrity check (checksum or head-object), and verify whether any backups "
        "actually landed in S3/GCS historically."
    ),
    acceptance=[
        "Script executes successfully end-to-end for both STORAGE_TYPE=s3 and STORAGE_TYPE=gcs, tested in CI with a local MinIO/fake-gcs-server harness.",
        "Function definitions moved above (or guarded by) a main() invocation so ordering regressions are caught by shellcheck plus an actual execution test.",
        "A post-upload verification step is added; failure surfaces distinctly from dump failure.",
        "The historical gap is documented and a manual backup is taken immediately as a stopgap.",
    ],
    files=["scripts/backup-db.sh", ".github/workflows/database-backup.yml"],
),

dict(
    area="Infra",
    title="No PodDisruptionBudget for any workload despite the scheduler's own RBAC already provisioning for it",
    summary="k8s/scheduler/rbac.yaml grants read access to PodDisruptionBudgets, acknowledging PDB-awareness is part of the design, yet no PodDisruptionBudget object exists anywhere in the repo — every multi-replica workload can be drained to zero simultaneously.",
    details=(
        "`k8s/scheduler/rbac.yaml` grants the `greenpay-scheduler` ClusterRole get/list/watch on "
        "`poddisruptionbudgets`, but no `PodDisruptionBudget` resource exists anywhere under `k8s/` or "
        "`helm/greenpay/templates/`. `backend`, `frontend`, `summary-worker` (2 replicas each), and "
        "`ml-inference` (2 replicas, HPA min 1) can all be drained to zero simultaneously during a node "
        "upgrade or cluster-autoscaler scale-down, causing a full donation-flow outage."
    ),
    approach=(
        "Add PDBs per workload, reasoning carefully about minAvailable vs maxUnavailable given ml-inference's "
        "HPA can shrink to minReplicas: 1 (so minAvailable: 1 would block all voluntary eviction — use "
        "maxUnavailable: 1 instead), coordinated with the existing topologySpreadConstraints on backend."
    ),
    acceptance=[
        "PDBs added for backend, frontend, summary-worker, ml-inference, and postgres (with an explicit, documented decision for the single-replica StatefulSet).",
        "Verified via kubectl drain --dry-run simulation that at least one replica of each multi-replica service always remains.",
        "PDBs added to both raw k8s/kustomization.yaml resources and the Helm chart templates for parity.",
    ],
    files=["k8s/scheduler/rbac.yaml", "k8s/backend.yaml", "k8s/frontend.yaml", "helm/greenpay/templates"],
),

dict(
    area="Infra",
    title="Backend, frontend, and postgres have no livenessProbe — only readinessProbe",
    summary="k8s/backend.yaml, frontend.yaml, and postgres.yaml (and their Helm equivalents) define only readinessProbe; a deadlocked pod is pulled from Service endpoints but never restarted by kubelet.",
    details=(
        "Contrast with `k8s/ml-workloads/ml-inference.yaml` and `k8s/scheduler/deployment.yaml`, which "
        "correctly define both liveness and readiness probes. Without a livenessProbe, a backend pod that "
        "deadlocks (exhausted DB connection pool, hung Stellar Horizon call) sits consuming its request/"
        "limit quota indefinitely, silently shrinking effective capacity, since kubelet has no signal to "
        "restart it."
    ),
    approach=(
        "Add livenessProbe blocks with a dedicated shallow endpoint (e.g. /livez) distinct from the existing "
        "deep-dependency-checking /health used for readiness, so a Horizon/DB outage causes graceful "
        "readiness failure rather than a liveness-triggered crash-loop cascade."
    ),
    acceptance=[
        "Backend/frontend/postgres gain livenessProbe blocks with appropriate failureThreshold/periodSeconds.",
        "Backend exposes a shallow /livez distinct from the deep-check /health used for readiness.",
        "Postgres liveness uses pg_isready with a longer initialDelaySeconds than readiness to avoid restart storms on slow WAL recovery.",
    ],
    files=["k8s/backend.yaml", "k8s/frontend.yaml", "k8s/postgres.yaml", "helm/greenpay/templates"],
),

dict(
    area="Infra",
    title="Secrets are committed as plaintext with a live default password — no External Secrets/Vault/SOPS integration",
    security=True,
    summary="k8s/secret.yaml and the Helm chart's values.yaml hardcode POSTGRES_PASSWORD: \"changeme\" directly in tracked YAML, with no secret-management layer, so any real deployment either ships the weak default or requires manually editing tracked files with production credentials.",
    details=(
        "`k8s/secret.yaml` and `helm/greenpay/templates/secret.yaml` (backed by `helm/greenpay/values.yaml`'s "
        "`secrets.postgresPassword: changeme`) hardcode the password in `stringData` and interpolate it "
        "directly into `DATABASE_URL`. There is no External Secrets Operator, Vault, or SOPS/sealed-secrets "
        "layer — these manifests are meant to be applied directly from the repo, meaning production "
        "credentials either default to a weak, publicly-visible value or must be hand-edited into tracked "
        "files (high risk of accidental commit)."
    ),
    approach=(
        "Add a secrets.provider: inline|external toggle to the Helm chart, wire an ExternalSecret template "
        "for a real backend (AWS Secrets Manager/Vault), and remove the production-shaped default password."
    ),
    acceptance=[
        "helm/greenpay/values.yaml supports a secrets.provider: inline|external toggle.",
        "An ExternalSecret template is added, referencing a real secret backend, gated behind the toggle.",
        "No production-shaped default password remains checked into git.",
        "docs/deployment-mainnet.md is updated to reference the secure secret path.",
    ],
    files=["k8s/secret.yaml", "helm/greenpay/templates/secret.yaml", "helm/greenpay/values.yaml"],
),

dict(
    area="Infra",
    title="No NetworkPolicy anywhere — postgres is reachable from any pod in the cluster",
    security=True,
    summary="Zero NetworkPolicy resources exist; postgres-svc has no ingress restriction, so any pod scheduled into the namespace (or cluster, absent a default-deny) can attempt to connect to port 5432 directly.",
    details=(
        "No `NetworkPolicy` resources exist under `k8s/` or `helm/`. The headless `postgres-svc` (`k8s/"
        "postgres.yaml`) has no ingress restriction, so any pod in the `greenpay` namespace (or cluster-"
        "wide, absent a default-deny) can open a TCP connection to 5432 and attempt credential-stuffing "
        "against `POSTGRES_USER`/`POSTGRES_PASSWORD`. The separate `greenpay-scheduler` namespace also has "
        "no egress restriction despite its ClusterRole having broad cluster-wide read access to Node/Pod "
        "objects."
    ),
    approach=(
        "Map the real east-west traffic graph (backend/summary-worker → postgres; scheduler → API server "
        "cross-namespace) and author default-deny + explicit-allow NetworkPolicies without breaking headless "
        "StatefulSet DNS resolution or cross-namespace scheduler traffic."
    ),
    acceptance=[
        "Default-deny ingress policy added per namespace (greenpay, greenpay-scheduler).",
        "Explicit allow-list: backend/summary-worker → postgres:5432 only.",
        "ml-inference/ml-training are explicitly denied DB access (they don't need it).",
        "Policy validated against the target CNI (Calico/Cilium) in a test cluster before merge.",
    ],
    files=["k8s/postgres.yaml", "k8s/scheduler"],
),

dict(
    area="Infra",
    title="No HorizontalPodAutoscaler for backend or frontend despite the pattern already existing for ml-inference",
    summary="ml-inference has a full autoscaling/v2 HPA with GPU/queue-depth metrics, but backend/frontend replica counts are hardcoded at 2 with no autoscaling — undermining the documented p95/throughput SLOs under real traffic spikes.",
    details=(
        "`k8s/ml-workloads/ml-inference.yaml` defines a complete HPA (`ml-inference-hpa`, GPU utilization + "
        "custom queue-depth metrics). Nothing equivalent exists for `backend`/`frontend` — replicas are "
        "hardcoded (`replicas: 2`). `docs/performance.md` sets hard SLOs (p95 < 500ms, ≥100 req/s sustained) "
        "validated by `scripts/load-test.js`, but there's no mechanism to actually hold those SLOs under a "
        "real donation traffic spike (e.g. a viral campaign) beyond a fixed 2-pod fleet."
    ),
    approach=(
        "Add an HPA for backend (CPU + custom request-latency/queue-depth metric) and frontend (CPU/RPS), "
        "tuned so scale-up is fast enough to protect p95 latency without fighting the existing "
        "topologySpreadConstraints."
    ),
    acceptance=[
        "HPA added for backend and frontend with appropriate metrics.",
        "scripts/load-test.js run against an HPA-enabled deployment confirms p95 stays under target during a scale event.",
        "HPA manifests added to both k8s/kustomization.yaml and the Helm chart.",
    ],
    files=["k8s/ml-workloads/ml-inference.yaml", "k8s/backend.yaml", "helm/greenpay/values.yaml", "docs/performance.md"],
),

dict(
    area="Infra",
    title="Ingress has no TLS termination configured in either raw manifests or the Helm chart",
    security=True,
    summary="Both k8s/ingress.yaml and helm/greenpay/templates/ingress.yaml define only HTTP rules with no spec.tls block or cert-manager annotation, despite docs/deployment-mainnet.md assuming https:// URLs everywhere.",
    details=(
        "Neither Ingress manifest defines a `tls` block, `cert-manager.io/cluster-issuer` annotation, or "
        "`secretName`. `docs/deployment-mainnet.md` configures `ALLOWED_ORIGINS`/`NEXT_PUBLIC_API_URL` with "
        "`https://` URLs, implicitly assuming TLS termination exists somewhere never actually defined "
        "in-repo. For a platform moving real funds and wallet keys through the frontend, this is a concrete "
        "gap between docs and infra."
    ),
    approach=(
        "Add a tls block to both Ingress definitions, driven by a new ingress.tlsSecretName/enableTLS Helm "
        "value, and wire a cert-manager ClusterIssuer for the production overlay."
    ),
    acceptance=[
        "tls block added to both Ingress definitions, parameterized via Helm values.",
        "cert-manager ClusterIssuer manifest and annotation added for the production overlay.",
        "docs/deployment-mainnet.md updated with the actual TLS provisioning step it currently omits.",
    ],
    files=["k8s/ingress.yaml", "helm/greenpay/templates/ingress.yaml", "docs/deployment-mainnet.md"],
),

dict(
    area="Infra",
    title="Postgres has no HA/replication, and the documented PITR strategy is never actually wired into the manifest",
    summary="The postgres StatefulSet runs a single replica with a single PVC and no standby; docs/database.md describes WAL archiving for point-in-time recovery, but none of it (ConfigMap, archive sidecar, archive_command) exists in the actual manifest.",
    details=(
        "`k8s/postgres.yaml` and the Helm equivalent run `replicas: 1` with a single ReadWriteOnce PVC and "
        "no standby. `docs/database.md`'s \"Point-in-Time Recovery\" section describes `wal_level = "
        "replica`, `archive_mode = on`, `archive_command = 'aws s3 cp %p s3://...'`, but none of this "
        "appears in the StatefulSet's config — no postgresql.conf ConfigMap, no archive sidecar. Combined "
        "with the currently-broken nightly pg_dump (see the companion backup-script issue), the realistic "
        "worst case for a lost PVC is up to 24 hours of donation/transaction data loss."
    ),
    approach=(
        "Add a postgresql.conf ConfigMap with WAL archiving wired to S3/GCS with least-privilege "
        "credentials, and record a documented decision (ADR-style, matching docs/adr/) on managed-Postgres "
        "vs. self-hosted HA."
    ),
    acceptance=[
        "postgresql.conf ConfigMap with WAL archiving mounted into the StatefulSet, archive_command wired with least-privilege credentials.",
        "Documented RPO/RTO numbers backed by an actual tested restore-to-point-in-time drill.",
        "An ADR records the managed-Postgres vs. self-hosted-HA decision, since the current single-pod StatefulSet can't meet any real RTO target.",
    ],
    files=["k8s/postgres.yaml", "docs/database.md", "docs/adr"],
),

dict(
    area="Infra",
    title="Helm chart has a single, unparameterized values.yaml — no environment separation for testnet vs. mainnet",
    security=True,
    summary="values.yaml hardcodes stellarNetwork: testnet, ingress.host: greenpay.local, and the default password in one file, while docs/deployment-mainnet.md describes an entirely separate, hand-edited .env cutover — two disconnected deployment paths for a network mismatch that's a fund-losing class of bug.",
    details=(
        "`helm/greenpay/values.yaml` hardcodes `config.stellarNetwork: testnet`, `ingress.host: greenpay."
        "local`, and `secrets.postgresPassword: changeme` in one file with no `values-staging.yaml`/`values-"
        "production.yaml` overlay convention. `docs/deployment-mainnet.md` describes a manual mainnet "
        "cutover by hand-editing `backend/.env`/`frontend/.env.local` directly, entirely bypassing Helm — "
        "meaning there's real risk of `helm upgrade` running with stale testnet values against a production "
        "cluster, or vice versa, particularly around `STELLAR_NETWORK`/`CONTRACT_ID`/`HORIZON_URL`."
    ),
    approach=(
        "Split values.yaml into base defaults plus a values-mainnet.yaml overlay, add a CI/pre-deploy check "
        "that fails if stellarNetwork: mainnet is ever combined with a testnet Horizon URL or default "
        "password, and reconcile the Helm and hand-edited-.env deployment paths into one source of truth."
    ),
    acceptance=[
        "values.yaml is split into defaults + a mainnet overlay with network/contract/ingress fields overridden.",
        "A CI/pre-deploy check fails if stellarNetwork: mainnet is combined with a testnet Horizon URL or default password.",
        "docs/deployment-mainnet.md is rewritten to deploy via Helm, or explicitly documents why the paths diverge.",
    ],
    files=["helm/greenpay/values.yaml", "docs/deployment-mainnet.md"],
),

dict(
    area="Infra",
    title="No container image scanning, no build/push pipeline, and images run as root with :latest tags",
    security=True,
    summary="No workflow builds/pushes/scans backend or frontend images; every Deployment references image: greenpay/*:latest with imagePullPolicy: IfNotPresent, and neither Dockerfile sets a non-root USER, unlike the scheduler's distroless-nonroot build.",
    details=(
        "`.github/workflows/ci.yml` runs an OWASP ZAP DAST scan and secret-scanning exists separately, but "
        "no workflow builds/pushes any image, and there is no Trivy/Grype/Snyk container-scan step anywhere. "
        "Every Deployment references `image: greenpay/*:latest` with `imagePullPolicy: IfNotPresent`, so "
        "nodes can silently run a stale/unscanned cached image with no digest pinning and no way to know "
        "which git commit is actually running. `backend/Dockerfile` and `frontend/Dockerfile` have no "
        "`USER` directive (root by default), unlike `scheduler/Dockerfile`'s distroless-nonroot build and "
        "`k8s/scheduler/deployment.yaml`'s explicit `runAsNonRoot`/`readOnlyRootFilesystem`/`capabilities: "
        "drop: [\"ALL\"]`."
    ),
    approach=(
        "Add a CI stage that builds, SHA-tags, Trivy-scans (failing on HIGH/CRITICAL), and pushes backend/"
        "frontend/scheduler images; add non-root USER to both Dockerfiles with matching K8s securityContext "
        "blocks; switch manifests to immutable tags/digests."
    ),
    acceptance=[
        "CI builds backend/frontend/scheduler images, tags with git SHA, scans with Trivy (fail on HIGH/CRITICAL), pushes to registry.",
        "K8s/Helm manifests reference immutable tags/digests, not :latest.",
        "backend/Dockerfile and frontend/Dockerfile add non-root USER; matching securityContext added to backend.yaml/frontend.yaml, mirroring scheduler/deployment.yaml.",
        "imagePullPolicy changed to Always (or digest-pinned) to eliminate stale-cache risk during rollout.",
    ],
    files=["backend/Dockerfile", "frontend/Dockerfile", "k8s/backend.yaml", "k8s/frontend.yaml", ".github/workflows/ci.yml"],
),


# ═══════════════════════════════════════════════════════════════════════════
# SCHEDULER (Go k8s scheduler plugin) — 10
# ═══════════════════════════════════════════════════════════════════════════

dict(
    area="Scheduler",
    title="MLWorkloadScore.Score() never resolves the candidate node — the plugin is a silent no-op on every real cluster",
    summary="Score() reads node info from CycleState under framework.NodeInfoSnapshotKey, but nothing anywhere in the codebase ever writes to that key, and the constructor discards its framework.Handle argument, so `node` is always nil and every score falls back to the neutral default.",
    details=(
        "In `pkg/plugins/score.go`, `Score()` tries `state.Read(framework.NodeInfoSnapshotKey)` (line ~152), "
        "but only `bandwidthStateKey` is ever written to `CycleState` anywhere in this plugin (line ~123) — "
        "`framework.NodeInfoSnapshotKey` is read but never written by anything. `NewMLWorkloadScore` also "
        "discards its `framework.Handle` argument (`_ framework.Handle`), so there's no `SnapshotSharedLister"
        "()` reference to look the node up through either. The result: `node` is always nil, and every "
        "node's score falls into the neutral fallback (`framework.MaxNodeScore/2`, line ~163) on every "
        "scheduling cycle, regardless of GPU, NUMA, or bandwidth data — the plugin's entire scoring logic "
        "never actually runs against real node data."
    ),
    approach=(
        "Store the framework.Handle from the constructor and retrieve node info via handle."
        "SnapshotSharedLister().NodeInfos().Get(nodeName) instead of the broken CycleState read path."
    ),
    acceptance=[
        "MLWorkloadScore stores framework.Handle from its constructor.",
        "Score() retrieves node info via the handle's shared lister instead of CycleState.",
        "A regression test asserts sub-scores actually vary node-to-node for a realistic node set.",
        "The dead framework.NodeInfoSnapshotKey read path is removed.",
    ],
    files=["scheduler/pkg/plugins/score.go"],
),

dict(
    area="Scheduler",
    title="binPackingScore measures static resource reservation, not actual pod bin-packing, despite carrying the highest weight",
    summary="The largest-weighted (0.40) sub-score computes capacity minus allocatable — both static, kubelet-reported values that never change as pods are scheduled — instead of NodeInfo.Requested, which the code's own comment admits is what a production version would use.",
    details=(
        "`binPackingScore` (scheduler/pkg/plugins/score.go, line ~244) computes `usedMilliCPU := capacity."
        "Cpu().MilliValue() - allocatableMilliCPU`. Capacity and Allocatable are both static per-node values "
        "reported by kubelet; their difference doesn't change as pods bind to the node. This is the only "
        "implementation, yet it carries the largest weight (0.40) of the whole composite score, meaning the "
        "plugin's single biggest signal never reflects real-time cluster packing state at all."
    ),
    approach=(
        "Plumb framework.NodeInfo.Requested (which reflects pods already bound/assumed on the node) through "
        "to this sub-score, correctly accounting for GPU extended resources alongside CPU."
    ),
    acceptance=[
        "binPackingScore takes *framework.NodeInfo and computes fraction from nodeInfo.Requested vs nodeInfo.Allocatable.",
        "GPU extended-resource requests (e.g. nvidia.com/gpu) are included in the packing ratio, not just CPU.",
        "A unit test with a NodeInfo populated with several assumed pods proves the score changes as pods are added.",
    ],
    files=["scheduler/pkg/plugins/score.go"],
),

dict(
    area="Scheduler",
    title="GPU capacity is never checked against pods already scheduled — a fully-allocated GPU node still passes the filter",
    summary="GPUHardwareFilter only compares static node labels (vendor/model/VRAM) against pod annotations; it never reads nodeInfo.Requested for GPU extended resources, so it has no way to know how many of a node's GPUs are already consumed.",
    details=(
        "`GPUHardwareFilter.Filter` (scheduler/pkg/plugins/filter.go) compares `gpu-vendor`/`gpu-model`/"
        "`gpu-vram-mib` node labels against pod annotations but never cross-references `nodeInfo.Requested`/"
        "`Allocatable` extended resources. A node with 8 GPUs, all already allocated to other pods, still "
        "passes the filter for a new GPU pod as long as the vendor/model/VRAM labels match, meaning the "
        "scheduler can happily overcommit GPU nodes it believes have capacity."
    ),
    approach=(
        "Compute remaining GPU count from nodeInfo.Requested/Allocatable extended resources and reject nodes "
        "with zero free GPU capacity, reconciling the label-based hardware model with the standard "
        "Kubernetes extended-resource accounting model."
    ),
    acceptance=[
        "Filter computes remaining GPU count and rejects nodes with zero free GPUs.",
        "A test simulates a NodeInfo whose GPUs are already fully allocated.",
        "Filter reason message reports \"0 of N GPUs free\" for that case.",
    ],
    files=["scheduler/pkg/plugins/filter.go"],
),

dict(
    area="Scheduler",
    title="fragmentationScore ignores its own documented fragThreshold field and computes nothing from actual GPU allocation",
    summary="fragThreshold is documented as driving a V-shaped scoring curve based on GPU allocation fraction, but fragmentationScore never references it or any allocation data — it returns hardcoded constants purely from the GPUInterconnect string.",
    details=(
        "`MLWorkloadScore.fragThreshold` (scheduler/pkg/plugins/score.go, line ~83, set to 0.85) is "
        "documented as driving a \"V-shaped\" curve based on GPU allocation fraction, but `fragmentationScore` "
        "(line ~284) never references `s.fragThreshold` or any allocation data at all — it returns hardcoded "
        "constants (85/70/50) purely from the `GPUInterconnect` string. The field is dead code and the "
        "doc/implementation directly contradict each other."
    ),
    approach=(
        "Implement the actual documented V-shaped curve using real per-node GPU-allocation-fraction data "
        "(tied to the companion GPU-capacity-accounting issue), centered at a now-configurable fragThreshold."
    ),
    acceptance=[
        "fragmentationScore computes an allocated-GPU fraction from NodeInfo and applies the documented V-curve centered at fragThreshold.",
        "fragThreshold becomes configurable (not just a constructor literal) and is exercised by tests.",
        "A test asserts scores near 0% and 100% allocation score high, near fragThreshold scores low.",
    ],
    files=["scheduler/pkg/plugins/score.go"],
),

dict(
    area="Scheduler",
    title="No preemption/eviction plugin exists for ML workloads despite the scoring design assuming dense GPU packing",
    summary="RegisterPlugins wires up only a Filter and a Score plugin — there's no PostFilter/preemption plugin, so a high-priority training pod that fails filtering due to GPU contention can't evict lower-priority inference/batch pods.",
    details=(
        "`RegisterPlugins` (scheduler/pkg/register.go) wires up only `GPUHardwareFilter` and `MLWorkloadScore` "
        "— there's no `PostFilter`/preemption plugin, meaning a high-priority `ml-training` pod that fails "
        "filtering due to GPU contention cannot trigger eviction of lower-priority `ml-batch`/`ml-inference` "
        "pods to make room, despite the scoring plugin's entire design assuming GPU nodes are densely "
        "packed with ML jobs."
    ),
    approach=(
        "Implement a GPU-aware PostFilter preemption plugin that selects victims based on workload priority "
        "and freed VRAM/GPU-count sufficiency, respecting PodDisruptionBudgets and avoiding cascades."
    ),
    acceptance=[
        "A new PostFilter plugin selects preemption victims based on workload priority and freed GPU/VRAM sufficiency.",
        "Victim selection respects PDBs and avoids preempting pods that wouldn't free enough resources.",
        "Tests cover: no victim needed, single-victim success, insufficient-capacity-even-after-preemption.",
    ],
    files=["scheduler/pkg/register.go"],
),

dict(
    area="Scheduler",
    title="NormalizeScore always stretches the best node to MaxNodeScore, destroying absolute-quality signal",
    summary="Dividing every score by the cycle's observed max score means the best node in a genuinely mediocre cluster gets rescaled to 100 — indistinguishable from an excellent placement — which defeats correct interaction with other weighted plugins in the scheduler profile.",
    details=(
        "`NormalizeScore` (scheduler/pkg/plugins/score.go, line ~208) divides every score by the cycle's max "
        "observed raw score, so the best available node in a mediocre cluster (e.g. all real composites "
        "~40) gets rescaled to 100 — identical to a genuinely excellent placement. This defeats the purpose "
        "of combining MLWorkloadScore with other weighted plugins (NodeResourcesFit, etc.) in the scheduler "
        "profile, since a node set with little real differentiation gets treated by the profile's weighted "
        "sum as if this plugin has a strong, confident opinion."
    ),
    approach=(
        "Replace relative-max normalization with a scheme that preserves absolute score magnitude (e.g. pass "
        "raw [0,100] through, or normalize against a documented theoretical max instead of observed max), "
        "documenting the interaction with KubeSchedulerProfile plugin weights."
    ),
    acceptance=[
        "Relative-max normalization is replaced with an absolute-magnitude-preserving scheme.",
        "Interaction with scheduler profile plugin weights is documented.",
        "A test with a cluster where all nodes score ~40 no longer produces a 100-scored node.",
    ],
    files=["scheduler/pkg/plugins/score.go"],
),

dict(
    area="Scheduler",
    title="The bin-pack-weight pod annotation has no documented upper bound enforced, letting one pod saturate all node scores to a tie",
    summary="The doc comment states the valid range is 0–2, but ParsePodHardwareReqs only checks the value is non-negative — an annotation like \"5\" saturates nearly every node's composite score to exactly 100, collapsing differentiation into a random tie-break.",
    details=(
        "The doc comment for `AnnotBinPackWeight` (scheduler/pkg/hardware/labels.go, line ~91) states the "
        "valid range is \"0–2\", but `ParsePodHardwareReqs` (scheduler/pkg/hardware/node_info.go, line ~98) "
        "only checks `f >= 0` — no upper clamp. Combined with `composite = math.Min(composite, 100.0)` in "
        "Score(), any workload author setting e.g. `bin-pack-weight: \"5\"` causes nearly every viable "
        "node's composite to saturate at exactly 100, collapsing all meaningful score differentiation for "
        "that pod into a random tie-break."
    ),
    approach=(
        "Clamp BinPackWeight to its documented [0, 2] range in ParsePodHardwareReqs, with a metric/log "
        "warning when clamping occurs."
    ),
    acceptance=[
        "ParsePodHardwareReqs clamps BinPackWeight to [0, 2] per its documented contract.",
        "A test proves annotation values \"5\" and \"-1\" are both clamped/rejected per the documented range.",
        "A metric/log warning fires when clamping occurs so misconfigured pods are visible to operators.",
    ],
    files=["scheduler/pkg/hardware/labels.go", "scheduler/pkg/hardware/node_info.go"],
),

dict(
    area="Scheduler",
    title="NUMA scoring ignores real GPU-to-NUMA topology affinity",
    summary="numaScore scores purely on total NUMA-domain count vs. workload type, never considering how the node's GPUs are actually distributed across those domains or how many GPUs the specific pod requests, and has no integration with kubelet's Topology Manager.",
    details=(
        "`numaScore` (scheduler/pkg/plugins/score.go, line ~315) scores purely on `hw.NUMANodes` count vs. "
        "workload type (more NUMA domains = better for training), but never considers how the node's GPUs "
        "are actually distributed across those NUMA domains, nor how many GPUs the specific pod requests. A "
        "training pod requesting 1 GPU on a node with \"4 NUMA domains\" scores maximally even if that single "
        "GPU sits entirely within one NUMA domain, gaining nothing from the extra domains — and there's no "
        "coordination with kubelet's Topology Manager to confirm alignment will actually be honored."
    ),
    approach=(
        "Extend the node hardware label set with a GPU-per-NUMA-domain distribution for topology-aware "
        "scoring, and document/verify the assumption about kubelet Topology Manager policy alignment."
    ),
    acceptance=[
        "Node hardware labels are extended with a GPU-per-NUMA-domain distribution.",
        "numaScore accounts for the pod's requested GPU count relative to that distribution.",
        "The kubelet Topology Manager policy alignment assumption is documented and, where possible, verified.",
    ],
    files=["scheduler/pkg/plugins/score.go", "scheduler/pkg/hardware"],
),

dict(
    area="Scheduler",
    title="Zero test coverage exists for MLWorkloadScore — the most complex plugin in the repo",
    summary="pkg/hardware and pkg/plugins have tests for node-info parsing and filtering, but there is no score_test.go anywhere despite this plugin containing the composite weighted scoring, PreScore aggregation, NormalizeScore rescaling, and four sub-score heuristics.",
    details=(
        "`pkg/hardware` has `node_info_test.go` and `pkg/plugins` has `filter_test.go`, but there is no "
        "`score_test.go` anywhere. `MLWorkloadScore` contains the composite weighted scoring, `PreScore` "
        "cluster-state aggregation, `NormalizeScore` rescaling, and four sub-score heuristics — none of it "
        "is exercised by a single test. The companion issue about Score() silently no-op'ing on every real "
        "cluster would have been caught immediately by a basic test asserting sub-scores vary between "
        "differently-labeled nodes."
    ),
    approach=(
        "Write score_test.go covering each sub-score function in isolation, plus an integration-style test "
        "running PreScore → Score → NormalizeScore across a multi-node fixture."
    ),
    acceptance=[
        "score_test.go covers each sub-score function in isolation.",
        "An integration-style test runs PreScore → Score → NormalizeScore across a realistic multi-node fixture and asserts differentiated results.",
        "A regression test specifically pins down the CycleState node-lookup path (would catch regressions of the Score() no-op bug).",
    ],
    files=["scheduler/pkg/plugins"],
),

dict(
    area="Scheduler",
    title="Node hardware labels are re-parsed from scratch on every PreScore and every Score call, with no caching",
    summary="hardware.ParseNodeHardware(node) is called once per node inside PreScore's loop and again per node inside Score — twice per node per pod, with no memoization keyed on node resourceVersion, becoming a measurable hot-path cost under scheduling bursts.",
    details=(
        "`hardware.ParseNodeHardware(node)` is called once per node inside `PreScore`'s loop (scheduler/pkg/"
        "plugins/score.go, line ~115) and again per node inside `Score` (line ~167) — i.e. twice per node "
        "per pod, with no memoization keyed on node `resourceVersion`. Under high scheduling throughput "
        "(batch ML job submission bursts), this becomes a measurable hot-path cost: string map lookups and "
        "strconv.ParseInt/ParseFloat calls repeated for every node for every pod, even though node labels "
        "change far less often than pods are scheduled."
    ),
    approach=(
        "Cache NodeHardware parsing results keyed by node name + resourceVersion, invalidated via an "
        "informer event handler on node update/delete."
    ),
    acceptance=[
        "NodeHardware parsing results are cached keyed by node name + resourceVersion.",
        "Cache is invalidated on node update/delete via an informer event handler.",
        "A benchmark demonstrates reduced CPU cost under repeated scheduling cycles against the same node set.",
    ],
    files=["scheduler/pkg/hardware", "scheduler/pkg/plugins/score.go"],
),

# ═══════════════════════════════════════════════════════════════════════════
# EXTENSION (Browser extension) — 8
# ═══════════════════════════════════════════════════════════════════════════

dict(
    area="Extension",
    title="WorkerSessionState mutations aren't serialized — concurrent background messages can corrupt persisted wallet-session state",
    security=True,
    summary="setWallet/clearWallet/setProjects each read-mutate-write with no mutex/queue; concurrent SET_WALLET_SESSION and CLEAR_WALLET_SESSION messages can interleave and leave chrome.storage.session inconsistent with in-memory state.",
    details=(
        "`setWallet`, `clearWallet`, and `setProjects` in `src/session-state.ts` each read/mutate the in-"
        "memory field synchronously, then `await` a `chrome.storage` write, with no mutex/queue. If "
        "`SET_WALLET_SESSION` and `CLEAR_WALLET_SESSION` messages arrive close together (e.g. an account-"
        "change mid-flow racing another connect attempt), the two async calls can interleave: the later-"
        "completing storage call can overwrite the other's persisted result, leaving `chrome.storage."
        "session` inconsistent with in-memory state — potentially resurrecting a cleared wallet session on "
        "the next worker restart, or vice versa."
    ),
    approach=(
        "Serialize all mutating operations on WorkerSessionState via a single in-flight-promise chain/mutex, "
        "without deadlocking initialize()'s own promise-memoization pattern."
    ),
    acceptance=[
        "All mutating operations on WorkerSessionState are serialized.",
        "A test simulates concurrent setWallet/clearWallet calls and asserts final in-memory state matches final persisted state.",
        "No regression to existing recovery/TTL tests in __tests__/session-recovery.test.ts.",
    ],
    files=["extension/src/session-state.ts"],
),

dict(
    area="Extension",
    title="Content-script address highlighting mutates a live NodeList while iterating it, risking skipped or duplicate matches",
    summary="highlightAddresses recurses over node.childNodes.forEach while the same function replaces the currently-visited child in place via replaceChild with a multi-node DocumentFragment — a classic mutate-while-iterating hazard on a live collection.",
    details=(
        "In `src/content-script.ts`, the element branch does `node.childNodes.forEach(child => "
        "highlightAddresses(child))` (line ~132), and the text-node branch of that same recursive call "
        "replaces the currently-visited child in place via `node.parentNode.replaceChild(fragment, node)` "
        "(line ~124) — replacing one node with a multi-node DocumentFragment mid-traversal. Because "
        "childNodes is a live NodeList, replacing the current index with a different number of nodes shifts "
        "subsequent sibling indices, so the ongoing forEach iteration can either skip an original sibling "
        "entirely or re-visit a freshly-inserted node — a hazard that only manifests on specific DOM shapes "
        "(e.g. a text node with an address adjacent to other siblings)."
    ),
    approach=(
        "Snapshot children (Array.from(node.childNodes)) before recursing, or restructure the replacement "
        "so it doesn't perturb sibling indices mid-iteration, preserving existing hostile-page hardening "
        "behavior."
    ),
    acceptance=[
        "Traversal no longer mutates the live collection it's iterating over.",
        "A new test with 3+ mixed text/element siblings around an address proves no sibling is skipped or double-processed.",
        "Existing hostile-page tests continue to pass unchanged.",
    ],
    files=["extension/src/content-script.ts"],
),

dict(
    area="Extension",
    title="Injected tooltips aren't excluded from the MutationObserver's generated-node tracking, risking an observer feedback loop and orphaned DOM",
    summary="createTooltip() appends a div directly to document.body on mouseenter but never adds it to GENERATED_NODES, so the page-wide MutationObserver re-scans the tooltip itself on every hover, and cleanup depends solely on mouseleave firing.",
    details=(
        "`createTooltip()` (extension/src/content-script.ts, line ~17) builds a tooltip div appended "
        "directly to `document.body` on `mouseenter`, but it's never added to `GENERATED_NODES` (unlike the "
        "highlighted span, line ~69). Since the page-wide MutationObserver watches document.body subtree "
        "for childList mutations, every tooltip mount triggers the observer to call highlightAddresses on "
        "the tooltip itself. Additionally, if a host page's own script removes the hovered span before "
        "mouseleave fires (common on SPA re-renders), the closure-captured tooltip is never removed, "
        "leaking an orphaned node in document.body."
    ),
    approach=(
        "Add tooltip nodes to GENERATED_NODES (or otherwise exclude them from re-scanning) on creation, and "
        "clean up tooltips on more than just mouseleave (e.g. also on detachment of the originating span)."
    ),
    acceptance=[
        "Tooltip nodes are excluded from re-scanning by the MutationObserver.",
        "Tooltip cleanup does not depend solely on mouseleave firing.",
        "A test proves no additional address-scan work occurs when a tooltip mounts/unmounts.",
    ],
    files=["extension/src/content-script.ts"],
),

dict(
    area="Extension",
    title="Debounced project search in the popup has no request sequencing — stale responses can clobber newer search results",
    summary="The search handler debounces the start of each request by 300ms per keystroke, but renderSearchResults unconditionally overwrites the dropdown with whatever response arrives, regardless of which query it was for.",
    details=(
        "`popup.ts`'s search handler (line ~325) debounces `REFRESH_PROJECTS` calls by 300ms per keystroke "
        "but issues each `send()` independently; `renderSearchResults` (line ~190) unconditionally "
        "overwrites the dropdown with whatever response arrives. If a user types past the debounce window "
        "(e.g. \"o\" then \"oc\") and the \"o\" request's round-trip through `background.ts`'s fetch completes "
        "after the \"oc\" request due to jitter, the dropdown shows stale results for a query the user has "
        "already refined away from — a classic out-of-order-async-response race across the popup/background "
        "message boundary, which has no native cancellation via chrome.runtime.sendMessage."
    ),
    approach=(
        "Tag each search request with a monotonically increasing sequence number or the query string itself, "
        "and have renderSearchResults ignore responses that don't match the latest issued query."
    ),
    acceptance=[
        "Each search request is tagged with a sequence number or matching query string.",
        "renderSearchResults ignores responses that don't match the latest issued query.",
        "A test simulates out-of-order response resolution and asserts only the latest query's results render.",
    ],
    files=["extension/src/popup.ts", "extension/src/background.ts"],
),

dict(
    area="Extension",
    title="No handling for a stale Stellar sequence number between loadAccount and submitTransaction",
    summary="donate() loads the account sequence number, then awaits an indefinite user-approval step in the Freighter UI before submitting — if the on-chain sequence advances during that wait, submission fails with only a raw error message and no recovery path.",
    details=(
        "`donate()` in `popup.ts` (line ~263) calls `buildDonationTransaction`, which loads the account's "
        "sequence number via `server.loadAccount()`, then awaits `signTransaction()` — an indefinite wait "
        "for user approval inside the Freighter extension UI — before finally calling `server."
        "submitTransaction()`. If the account's on-chain sequence number advances during that approval "
        "window (a concurrent transaction from another session/device, or a retry after a prior attempt), "
        "submission fails with a stale-sequence error; the code only surfaces the raw error via showStatus, "
        "with no detection or automatic rebuild-and-retry using a freshly-loaded sequence number."
    ),
    approach=(
        "Detect Horizon's bad-sequence error class specifically, reload the account, and offer to rebuild/"
        "re-sign rather than showing a generic failure — without risking double-submission or re-signing "
        "without user awareness."
    ),
    acceptance=[
        "Horizon's bad-sequence error is detected and distinguished from other submission failures in the UI.",
        "The account is reloaded and the user is offered to rebuild/re-sign.",
        "A test (with a mocked Horizon client) simulates a sequence bump between loadAccount and submitTransaction and asserts graceful recovery messaging.",
    ],
    files=["extension/src/popup.ts"],
),

dict(
    area="Extension",
    title="webpack.config.js is dead/broken configuration that diverges from the actual esbuild-based build and is missing the background entry point",
    summary="The actual build path is esbuild via package.json scripts; a separate, unmaintained webpack.config.js exists that builds only content-script and popup — missing the background service-worker entry entirely — and references devDependencies (webpack, ts-loader) that aren't installed.",
    details=(
        "`package.json`'s `build`/`build:firefox` scripts invoke esbuild directly and are the only build "
        "path actually exercised. `webpack.config.js` exists separately, builds only `content-script` and "
        "`popup` entries — missing the `background` entry point entirely, even though both manifests "
        "reference `dist/background.js`/`dist-firefox/background.js`. Neither `webpack` nor `ts-loader` "
        "(referenced in module.rules) appear in package.json's devDependencies, so the config can't even "
        "run as-is. This is a landmine: switching to the unmaintained config would silently drop the "
        "background service worker (breaking all wallet/session/message-passing functionality) with no "
        "build-time error, only a runtime manifest-load failure."
    ),
    approach=(
        "Either remove webpack.config.js entirely, or bring it to parity (add the background entry, add the "
        "missing devDependencies) and wire it into npm run build — and document which build system is "
        "canonical."
    ),
    acceptance=[
        "webpack.config.js is either removed, or brought to parity with the real build (background entry added, dependencies installed) and wired into npm run build.",
        "A CI/build step asserts dist/ and dist-firefox/ contain background.js, content-script.js, and popup.js after every build.",
        "Documentation states which build system is canonical.",
    ],
    files=["extension/webpack.config.js", "extension/package.json"],
),

dict(
    area="Extension",
    title="Firefox manifest uses the MV2 browser_action key under manifest_version: 3, untested for Chrome/Firefox drift",
    summary="manifest.firefox.json declares manifest_version 3 but uses browser_action (an MV2 key) instead of the MV3 action key used in manifest.json, with no manifest-shape test analogous to the existing CSP test catching this class of drift.",
    details=(
        "`manifest.firefox.json` declares `\"manifest_version\": 3` but uses `\"browser_action\"` (line ~6) "
        "instead of the MV3 `\"action\"` key used in `manifest.json`. Firefox's MV3 implementation expects "
        "`action`; the two manifests have diverged on this specific key with no test catching it — there is "
        "no manifest-shape test analogous to `manifest-csp.test.ts` that checks for correct action/"
        "browser_action key usage per manifest version."
    ),
    approach=(
        "Correct manifest.firefox.json to use action (verified against the declared strict_min_version), "
        "and add a manifest-shape test parallel to manifest-csp.test.ts that would catch future Chrome/"
        "Firefox field drift generally."
    ),
    acceptance=[
        "manifest.firefox.json uses action, verified against its declared strict_min_version.",
        "A manifest-shape test asserts the correct action key per manifest version.",
        "The popup is manually verified to register correctly in a real Firefox 120+ profile.",
    ],
    files=["extension/manifest.firefox.json", "extension/manifest.json"],
),

dict(
    area="Extension",
    title="activeTab and scripting permissions are declared but unused, unnecessarily widening the review/attack surface",
    summary="Both manifests declare activeTab and scripting permissions alongside <all_urls> host permissions, but nothing in src/ calls chrome.scripting.* or relies on activeTab's transient grant — the content script is instead statically injected on <all_urls>, making both extra permissions redundant.",
    details=(
        "Both `manifest.json` and `manifest.firefox.json` declare `\"permissions\": [\"storage\", "
        "\"activeTab\", \"scripting\"]` alongside `\"host_permissions\": [\"<all_urls>\"]`. Nothing in `src/` "
        "calls `chrome.scripting.*` or relies on activeTab's transient per-click grant — the content script "
        "is instead statically injected on `<all_urls>` via `content_scripts`, which is a strictly broader, "
        "always-on grant that makes activeTab redundant. `scripting` in particular grants the ability to "
        "dynamically inject arbitrary code into any page and is exactly the kind of permission store review "
        "scrutinizes, per PUBLISH.md's own note about needing to justify `<all_urls>`."
    ),
    approach=(
        "Remove scripting and activeTab from both manifests after confirming nothing (including third-party "
        "libs) implicitly depends on them, and re-validate the store justification text in PUBLISH.md."
    ),
    acceptance=[
        "scripting and activeTab are removed from both manifests if confirmed unused.",
        "A test asserts the permissions list contains no unused entries (or documents why each remaining permission is needed).",
        "PUBLISH.md's permission-justification section is updated to match the pruned manifest.",
    ],
    files=["extension/manifest.json", "extension/manifest.firefox.json", "extension/PUBLISH.md"],
),


# ═══════════════════════════════════════════════════════════════════════════
# CROSS-CUTTING — 20
# ═══════════════════════════════════════════════════════════════════════════

dict(
    area="Cross-cutting",
    title="No end-to-end test exercises the real backend + real Postgres + real frontend together — every e2e test mocks the API",
    summary="frontend/e2e/*.spec.ts mocks every backend call via page.route(); nothing in CI ever runs the actual request/response contract between frontend and backend, which is exactly how a versioning regression and a response-envelope bug both went undetected for a real stretch of time.",
    details=(
        "Every Playwright spec under `frontend/e2e/` mocks backend responses with `page.route(...)` — none "
        "of them boot the real Express server against a real (even ephemeral/test) Postgres instance and "
        "drive the frontend against it. This session personally found two real client/server contract bugs "
        "that this style of testing structurally cannot catch: the `/api/v1` versioning prefix silently "
        "reverting on the backend while the frontend kept assuming it existed, and `pages/donate/[id].tsx`'s "
        "`getServerSideProps` reading fields directly off the backend response instead of unwrapping its "
        "`{ success, data }` envelope. A genuine integration test suite (even a small one, covering the "
        "highest-value flows) would have caught both."
    ),
    approach=(
        "Add a CI job that boots the real backend against an ephemeral Postgres (Docker service container) "
        "and runs a small set of true end-to-end tests (no page.route mocking) covering donation, project "
        "browsing, and admin flows."
    ),
    acceptance=[
        "A CI job runs the real backend + real Postgres + real frontend together for at least the core donation flow.",
        "The test suite would have caught the /api/v1 versioning regression and the response-envelope-unwrapping bug if run against pre-fix code.",
        "This complements, not replaces, the existing mocked e2e suite (which remains valuable for speed/isolation).",
    ],
    files=["frontend/e2e", ".github/workflows/ci.yml"],
),

dict(
    area="Cross-cutting",
    title="CI's DAST scan targets a staging environment that doesn't exist — no real security scanning ever actually runs",
    summary="ci.yml's OWASP ZAP job is hardcoded to scan https://staging.greenpay.app, which doesn't resolve; the scan has been made non-blocking so CI passes, but that means the platform's dynamic security testing has never actually executed against anything real.",
    details=(
        "`.github/workflows/ci.yml`'s `zap_scan` job targets a hardcoded `https://staging.greenpay.app`. "
        "This URL doesn't currently resolve to anything, so the scan step fails at the DNS-resolution level "
        "on every run — it was made `continue-on-error: true` this session specifically so a nonexistent "
        "target doesn't fail the whole build, but that fix only addressed the CI symptom. The actual "
        "underlying gap remains: this platform has never had a real dynamic application security scan run "
        "against a real deployment, on every push to main, for its entire history."
    ),
    approach=(
        "Stand up an actual ephemeral staging deployment (per-PR or per-main-build) that ZAP can meaningfully "
        "scan, wiring the DAST job to target it instead of a hardcoded, nonexistent hostname."
    ),
    acceptance=[
        "A real, ephemeral staging environment is deployed as part of the CI/CD pipeline (or an existing persistent staging environment is stood up and kept alive).",
        "The ZAP scan targets that real environment and its findings are triaged, not silently swallowed by continue-on-error.",
        "A documented decision exists for scan cadence/target given cost/complexity trade-offs.",
    ],
    files=[".github/workflows/ci.yml"],
),

dict(
    area="Cross-cutting",
    title="escrow-contract and dao-governance-contract have never been through the audit process documented for greenpay-contract",
    security=True,
    summary="contracts/greenpay-contract/SECURITY.md documents a real audit methodology (CEI ordering, checked arithmetic, access control, front-running, event safety) that was applied to just one of the three contracts — the other two have real, findable vulnerabilities this audit already surfaced.",
    details=(
        "`contracts/greenpay-contract/SECURITY.md` documents a genuine audit methodology and its findings/"
        "fixes (including the exact CEI-ordering hardening in `donate()`). Neither `escrow-contract` nor "
        "`dao-governance-contract` has an equivalent SECURITY.md — and this is not a hypothetical gap: this "
        "same audit pass, applying that exact methodology, found a real CEI-ordering violation in escrow-"
        "contract and a real voting-power-inflation bug in dao-governance-contract (see the companion "
        "Contracts-area issues). Formalizing and applying the documented process to all three contracts "
        "would have caught both before they were ever filed as separate issues."
    ),
    approach=(
        "Apply greenpay-contract's documented audit methodology to escrow-contract and dao-governance-"
        "contract, producing an equivalent SECURITY.md for each, and fix the findings (tracked as the "
        "companion Contracts-area issues)."
    ),
    acceptance=[
        "escrow-contract and dao-governance-contract each get a SECURITY.md following greenpay-contract's documented methodology.",
        "Findings from this audit pass (CEI ordering, voting-power inflation, and any others surfaced) are tracked and fixed.",
        "A process is documented for re-running this audit methodology when either contract changes materially.",
    ],
    files=["contracts/greenpay-contract/SECURITY.md", "contracts/escrow-contract", "contracts/dao-governance-contract"],
),

dict(
    area="Cross-cutting",
    title="Three independent, weak Stellar-address validation implementations exist across frontend, mobile, and extension",
    summary="Web frontend's lib/stellar.ts, mobile's donate screen, and (implicitly) the extension's address handling each implement their own regex-based (not StrKey checksum) address validation, with no shared package — the same bug class exists in at least two of them, independently found this session.",
    details=(
        "`frontend/lib/stellar.ts`'s `isValidStellarAddress` and the equivalent ad-hoc regex found in "
        "`mobile/app/donate/[id].tsx`'s local wallet-connect flow both use `/^G[A-Z0-9]{55}$/` instead of "
        "real StrKey checksum validation — found independently in two separate parts of this audit, in two "
        "different codebases, with no shared validation package between the web frontend, mobile app, and "
        "browser extension despite all three needing the exact same Stellar-address-validation logic."
    ),
    approach=(
        "Extract a small, shared package (or at minimum, a documented canonical implementation copied "
        "consistently) for Stellar address/amount validation used by frontend, mobile, and extension, "
        "backed by StrKey rather than regex."
    ),
    acceptance=[
        "A single, StrKey-backed validation implementation is shared (or consistently duplicated with a cross-validation test) across frontend, mobile, and extension.",
        "The individual frontend and mobile issues in this batch are resolved as part of this consolidation.",
        "A test proves all three codebases reject the same set of checksum-invalid addresses.",
    ],
    files=["frontend/lib/stellar.ts", "mobile/app/donate/[id].tsx", "extension/src"],
),

dict(
    area="Cross-cutting",
    title="No centralized structured logging or correlation IDs across the ~5 independently-logging subsystems",
    summary="Backend, indexer, turrets, scheduler, and the mobile/extension clients all log independently with plain console.log/console.error (or Go's default logger) — there's no way to trace a single donation's full lifecycle across services when debugging a production issue.",
    details=(
        "Backend routes/services use scattered `console.log`/`console.error` calls with no log levels and "
        "no request-ID correlation. The event-sourcing pipeline, the Horizon indexer, the turrets matching "
        "service, and the Go scheduler all log independently with no shared correlation mechanism. "
        "Debugging \"why didn't donor X's donation show up\" currently requires manually cross-referencing "
        "timestamps across at least three separate log streams (API request, indexer processing, WebSocket "
        "emit) with nothing tying them together."
    ),
    approach=(
        "Adopt a structured logging library (e.g. pino) with consistent log levels, and thread a correlation/"
        "request ID from the initial HTTP request through the event-sourcing command, projection, and "
        "WebSocket emit, so a single donation's full path is traceable in logs."
    ),
    acceptance=[
        "A structured logging library replaces ad-hoc console.log/error calls in the backend, with consistent levels.",
        "A correlation ID is generated per request/donation and threaded through the command → projection → WebSocket-emit path.",
        "A documented example shows tracing one donation's full lifecycle across logs.",
    ],
    files=["backend/src"],
),

dict(
    area="Cross-cutting",
    title="No documented incident-response runbook for the highest-severity known failure modes",
    summary="\"The donation-matching hot wallet's key may be compromised\" and \"the indexer has fallen behind Horizon's ledger close rate\" are real, plausible operational failures for a platform handling live funds, with no documented response procedure for either.",
    details=(
        "This audit found concrete evidence both scenarios are realistic: the matcher hot wallet is a "
        "plaintext env-var secret with no circuit breaker (see the companion Backend issue), and the indexer "
        "has no cursor-resume/backfill mechanism at all (see the companion Backend issue on lastProcessed"
        "Ledger). Neither `docs/` nor any runbook-style document describes what an on-call operator should "
        "actually do if either failure is suspected or confirmed — key rotation steps, how to safely halt "
        "matching, how to detect and quantify indexer drift, or how to backfill missed donations."
    ),
    approach=(
        "Write incident-response runbooks for the highest-severity known failure modes, starting with "
        "matcher-key compromise and indexer lag/downtime, and link them from the on-call/deployment "
        "documentation."
    ),
    acceptance=[
        "A runbook exists for \"matcher hot wallet key may be compromised\" with concrete rotation/halt steps.",
        "A runbook exists for \"indexer has fallen behind or missed a downtime window\" with detection and backfill steps.",
        "Both are linked from the project's main operational documentation.",
    ],
    files=["docs"],
),

dict(
    area="Cross-cutting",
    title="Documentation makes infrastructure claims (PITR, TLS, staging) that aren't actually implemented",
    summary="docs/database.md describes a WAL-archiving PITR strategy never wired into the Postgres manifest, docs/deployment-mainnet.md assumes TLS termination that's never configured in any Ingress, and CI assumes a staging environment that doesn't exist — three separate doc/implementation mismatches found this session, with no process keeping docs and infra in sync.",
    details=(
        "This audit independently found: `docs/database.md`'s PITR section describes `archive_command` "
        "configuration absent from `k8s/postgres.yaml`; `docs/deployment-mainnet.md` configures `https://` "
        "URLs with no corresponding TLS setup in either Ingress manifest; and `.github/workflows/ci.yml`'s "
        "DAST scan assumes a `staging.greenpay.app` that doesn't resolve. Three independent doc/reality "
        "mismatches surfacing in one audit pass suggests there's no process — automated or manual review "
        "convention — that keeps documentation honest as infrastructure evolves (or fails to)."
    ),
    approach=(
        "Beyond fixing the three specific mismatches (tracked as their own issues), establish a lightweight "
        "convention (e.g. a docs-review checklist item in the PR template for infra changes) that catches "
        "this class of drift going forward."
    ),
    acceptance=[
        "The three specific mismatches are fixed (cross-referencing their own tracked issues).",
        "A documented convention (PR template checklist item, or periodic doc-audit) exists to catch future infra/docs drift.",
    ],
    files=["docs/database.md", "docs/deployment-mainnet.md", ".github/PULL_REQUEST_TEMPLATE.md"],
),

dict(
    area="Cross-cutting",
    title="No documented data-retention policy for donor personal data across device tokens, push subscriptions, and audit logs",
    summary="Device push tokens, IP addresses recorded in admin_audit_log, and donor profile data have no documented retention/deletion policy, despite this being a donation platform likely to have users across multiple jurisdictions with data-protection requirements.",
    details=(
        "The `device_tokens` table accumulates push tokens with no documented expiry beyond the (currently "
        "unimplemented, per the companion push-receipts issue) DeviceNotRegistered pruning. `admin_audit_"
        "log` records `ip_address` per action with no documented retention window. There is no privacy "
        "policy, data-retention schedule, or deletion-request handling process referenced anywhere in "
        "`docs/`, despite the platform collecting donor-identifying information (public keys, potentially "
        "device tokens tied to real people) that a real deployment serving donors globally would need to "
        "address."
    ),
    approach=(
        "Document a data-retention policy covering device tokens, audit-log IP addresses, and donor profile "
        "data, and implement corresponding automated cleanup/expiry where the policy calls for it."
    ),
    acceptance=[
        "A documented data-retention policy exists covering the major categories of personal data the platform stores.",
        "Automated cleanup/expiry is implemented where the policy calls for time-bounded retention.",
        "A deletion-request handling process is at least documented, even if manual initially.",
    ],
    files=["docs", "backend/src/db/schema.sql"],
),

dict(
    area="Cross-cutting",
    title="No automated regression test for the CSP header itself, despite two real CSP bugs shipping to production this session",
    summary="This session found and fixed a nonce/static-optimization mismatch that blocked every script in production, and a WebSocket-scheme CSP gap that silently broke the live donation feed — neither would have been caught by any existing automated test.",
    details=(
        "The frontend's `helmet()`/CORS/CSRF/CSP middleware stack (backend `server.js`, frontend "
        "`middleware.ts`) has no automated test asserting security headers are actually correct on real "
        "responses. This session independently discovered and fixed two real CSP regressions that had "
        "reached production undetected: a nonce mismatch that blocked literally every `<script>` tag site-"
        "wide, and a missing `ws://` scheme entry that silently broke the real-time donation feed's "
        "WebSocket connection. Both were only caught through manual e2e investigation, not any automated "
        "gate — meaning a *future* CSP regression of the same class has no safety net either."
    ),
    approach=(
        "Add an automated test (e2e or integration-level) that fetches real rendered pages, extracts the "
        "actual CSP header, and asserts every `<script>` tag's nonce matches it, and that connect-src covers "
        "every origin the app actually needs (API HTTP + WS, Stellar RPC/Horizon endpoints)."
    ),
    acceptance=[
        "An automated test asserts nonce-header/script-tag consistency on real rendered pages.",
        "An automated test asserts connect-src covers every origin the app's client-side code actually calls (HTTP and WebSocket).",
        "The test suite would have caught both CSP bugs fixed this session if run against their pre-fix code.",
    ],
    files=["frontend/middleware.ts", "frontend/e2e"],
),

dict(
    area="Cross-cutting",
    title="docs/openapi.yml is hand-maintained with no contract testing against the real Express routes",
    summary="Nothing validates that the OpenAPI spec served at /api/docs actually matches the real route implementations — this session found two real client/server contract mismatches that a spec-validation test would have caught structurally.",
    details=(
        "`backend/src/server.js` serves `docs/openapi.yml` via Swagger UI in non-production environments, "
        "but nothing validates incoming requests or outgoing responses against it, and there's no CI step "
        "that diffs the spec against the actual route implementations. This session found real, demonstrated "
        "drift between documented and actual API behavior (the /api/v1 versioning gap, and a response-"
        "envelope-unwrapping mismatch) — exactly the class of bug a contract-testing approach (e.g. "
        "generating request/response validation middleware from the OpenAPI spec, or a dedicated spec-vs-"
        "implementation test suite) is designed to catch."
    ),
    approach=(
        "Adopt an OpenAPI-driven request/response validation middleware (or a dedicated contract-test suite) "
        "so the spec and the implementation can't silently diverge, tying in with the companion schema-"
        "validation-library issue."
    ),
    acceptance=[
        "Either request/response validation middleware is generated from docs/openapi.yml, or a contract-test suite verifies the spec against real route behavior.",
        "CI fails when the spec and implementation diverge.",
        "The two already-found drifts (versioning, envelope-unwrapping) are reflected correctly in the spec.",
    ],
    files=["docs/openapi.yml", "backend/src/server.js"],
),

dict(
    area="Cross-cutting",
    title="Seven independent dependency ecosystems with no unified freshness/security dashboard",
    summary="frontend, backend, extension, mobile each have their own package-lock.json, contracts has Cargo.lock, scheduler has go.mod — this session personally found and fixed two broken lockfiles (a phantom dependency in backend, a stale lock in extension) that had been silently failing CI, with no process that would have caught either sooner.",
    details=(
        "The monorepo has seven independently-versioned dependency trees. This session found `backend/"
        "package.json` referencing a package (`expo-server-sdk-node`) that doesn't exist on the npm "
        "registry (the real package is `expo-server-sdk`) and `extension/package-lock.json` out of sync "
        "with its `package.json` — both had been causing `npm ci` to fail in CI for an unknown period before "
        "being fixed as part of this session's CI-repair work. Dependabot exists for six of the seven "
        "ecosystems (all but scheduler's go.mod, per the companion Backend issue), but there's no single "
        "place an operator can see \"is every lockfile in this monorepo currently valid and installable\"."
    ),
    approach=(
        "Add a lightweight CI job that runs `npm ci`/`cargo generate-lockfile --locked`/`go mod verify` "
        "across all seven ecosystems on a schedule (not just on changes to that specific directory), so a "
        "silently-broken lockfile is caught proactively rather than discovered when someone happens to touch "
        "that subproject."
    ),
    acceptance=[
        "A scheduled CI job verifies every lockfile across all seven ecosystems installs cleanly.",
        "Failures alert visibly (not just fail silently in a rarely-run workflow).",
        "The job would have caught both lockfile issues found and fixed this session, run against their pre-fix state.",
    ],
    files=[".github/workflows"],
),

dict(
    area="Cross-cutting",
    title="No load or chaos testing of the event-sourcing pipeline under realistic donation-spike volume",
    summary="The event-store scheduler polls every 500ms with a 200-event batch size, but there's no documented capacity/backpressure story for what happens when a viral campaign causes thousands of donations in minutes — no test exercises this.",
    details=(
        "`backend/src/eventSourcing/eventStore.js` defines `EVENT_STORE_BATCH_SIZE = 200` and `EVENT_STORE_"
        "POLL_INTERVAL_MS = 500` for its projection-processing scheduler, but there's no documented analysis "
        "of throughput capacity or backpressure behavior if the projection-processing rate falls behind the "
        "donation-ingestion rate during a real spike (e.g. a project going viral). `docs/performance.md` "
        "sets SLOs for the API layer, but nothing covers the event-sourcing pipeline's own capacity under "
        "burst load, and `scripts/load-test.js` (referenced by a companion infra issue) doesn't appear to "
        "exercise this path specifically."
    ),
    approach=(
        "Design and run a load test specifically targeting donation-ingestion-to-projection-catch-up "
        "latency under burst conditions, documenting the pipeline's actual capacity and backpressure "
        "behavior (or lack thereof)."
    ),
    acceptance=[
        "A load test exercises the event-sourcing pipeline under a simulated donation spike (many donations in a short window).",
        "Documented capacity numbers exist for projection-processing catch-up time under load.",
        "If backpressure/queueing behavior is inadequate, a remediation plan (e.g. dynamic batch sizing, horizontal scaling of the projection worker) is proposed.",
    ],
    files=["backend/src/eventSourcing/eventStore.js", "docs/performance.md"],
),

dict(
    area="Cross-cutting",
    title="No canary/staged-rollout deployment strategy — a bad backend deploy has no automated rollback trigger",
    summary="Nothing in the k8s/Helm manifests implements canary or blue-green deployment, and there's no automated rollback tied to error-rate/health metrics — a regression (like the /api/v1 versioning bug found and fixed this session, which had shipped to \"production\" per the repo's merge history) ships to 100% of traffic immediately with no automated safety net.",
    details=(
        "Deployments (`k8s/backend.yaml`, `frontend.yaml`) use a standard rolling-update strategy with no "
        "canary phase, no automated metric-based rollback, and no progressive-traffic-shifting mechanism "
        "(e.g. Argo Rollouts, Flagger). This session found and fixed a real regression (the /api/v1 "
        "versioning prefix silently reverting) that had evidently shipped through the normal merge/deploy "
        "process — a canary or staged rollout tied to error-rate monitoring is exactly the kind of safety "
        "net that would limit the blast radius of the next such regression to a small percentage of traffic "
        "instead of everyone immediately."
    ),
    approach=(
        "Introduce a progressive-delivery mechanism (Argo Rollouts or Flagger) for backend/frontend "
        "deployments, tied to error-rate/latency metrics for automated rollback."
    ),
    acceptance=[
        "Backend and frontend deploy via a canary or blue-green strategy rather than an immediate full rollout.",
        "Rollback triggers automatically on a defined error-rate/latency regression.",
        "A documented example (or drill) demonstrates the rollback actually working.",
    ],
    files=["k8s/backend.yaml", "k8s/frontend.yaml", "helm/greenpay"],
),

dict(
    area="Cross-cutting",
    title="No disaster-recovery game-day or tested restore procedure for the (currently broken) nightly backup",
    summary="\"A backup exists\" and \"a restore actually works\" are different claims — only the former is even attempted, and the companion infra issue found the backup script has been failing every run since introduction.",
    details=(
        "`.github/workflows/database-backup.yml` runs `scripts/backup-db.sh` nightly, which this audit "
        "found has been failing on every run since its introduction (a function-ordering bug, see the "
        "companion Infra issue). Even once that's fixed, there is no documented or tested restore procedure "
        "— no \"game day\" drill where a backup is actually restored to a fresh instance and verified. For a "
        "platform holding real donation records and financial history, the assumption that backups exist "
        "and would work if needed has never actually been validated end-to-end."
    ),
    approach=(
        "Once the backup script is fixed (companion issue), run and document a full restore drill on a "
        "regular cadence, verifying data integrity end-to-end."
    ),
    acceptance=[
        "A documented, tested restore procedure exists and has been executed at least once against a real backup.",
        "A recurring (e.g. quarterly) game-day drill is scheduled to re-verify the restore path continues to work.",
        "RPO/RTO numbers are derived from an actual timed drill, not estimated.",
    ],
    files=["scripts/backup-db.sh", ".github/workflows/database-backup.yml"],
),

dict(
    area="Cross-cutting",
    title="No shared/reusable CI composite actions — Node setup and dependency install are copy-pasted across four workflows",
    summary="ci.yml, contract-deploy.yml, extension.yml, and mobile.yml each independently repeat Node/npm setup and install steps with no DRY consolidation, making the exact \"lockfile silently out of sync\" class of bug this session fixed twice more likely to recur without anyone noticing the pattern.",
    details=(
        "`.github/workflows/ci.yml`, `contract-deploy.yml`, `extension.yml`, and `mobile.yml` each "
        "independently define near-identical `actions/setup-node` + `npm ci` steps with no shared composite "
        "action. This session found and fixed two separate, independent instances of a broken lockfile "
        "(backend, extension) causing `npm ci` to fail in CI — with no single, shared install step, there's "
        "no single place to add defensive checks (e.g. an early, clear failure message distinguishing "
        "\"package.json references a nonexistent package\" from \"lockfile is stale\") that would benefit "
        "every workflow at once."
    ),
    approach=(
        "Extract a shared composite GitHub Action for Node setup + dependency install, used consistently "
        "across all four workflows, with a clear, distinguishing error path for the lockfile-mismatch class "
        "of failure."
    ),
    acceptance=[
        "A shared composite action handles Node setup + install, used by ci.yml, contract-deploy.yml, extension.yml, and mobile.yml.",
        "The composite action surfaces a clear, distinguishing message for lockfile-mismatch failures.",
        "No behavior change to successful builds; only the failure-mode clarity and DRY-ness improve.",
    ],
    files=[".github/workflows/ci.yml", ".github/workflows/contract-deploy.yml", ".github/workflows/extension.yml", ".github/workflows/mobile.yml"],
),

dict(
    area="Cross-cutting",
    title="No documented threat model despite ADR-003's wallet-as-identity trust assumptions being violated by real backend routes",
    summary="docs/adr/ADR-003-authentication-approach-wallet-as-identity.md documents a significant trust model, but this audit found real backend routes (project status update, generate-summary) that don't actually enforce the proof-of-possession the ADR's model implicitly assumes — a governance gap where the documented security model isn't verified against the implementation.",
    details=(
        "`docs/adr/ADR-003-authentication-approach-wallet-as-identity.md` documents wallet-as-identity as "
        "the platform's authentication model, but the companion Backend security issues found this session "
        "show the implementation doesn't actually enforce proof-of-wallet-ownership for several project-"
        "owner actions, and one route (status update) has no authorization check at all. There's no broader "
        "threat model document or periodic security-review checklist that would have caught these "
        "violations of the ADR's own stated assumptions before this audit did."
    ),
    approach=(
        "Write a project-wide threat model document covering the major trust boundaries (wallet-as-identity, "
        "admin JWT auth, the matcher hot wallet, contract admin keys), and establish a periodic review "
        "process that checks the implementation against it."
    ),
    acceptance=[
        "A threat model document exists covering the platform's major trust boundaries and assumptions.",
        "It explicitly reconciles with ADR-003 and notes where the current implementation doesn't yet meet the documented model (cross-referencing the companion security issues).",
        "A periodic (e.g. per-major-release) review process is documented for re-checking implementation against the threat model.",
    ],
    files=["docs/adr/ADR-003-authentication-approach-wallet-as-identity.md"],
),

dict(
    area="Cross-cutting",
    title="No fuzz/property-based testing for escrow-contract or dao-governance-contract, despite dao-governance being the most state-machine-complex contract",
    summary="Only greenpay-contract's fuzz_tests.rs uses proptest; escrow-contract and dao-governance-contract — including the latter's multi-stage proposal lifecycle where the voting-power-inflation bug was found this session — have zero property-based coverage.",
    details=(
        "`contracts/greenpay-contract/src/fuzz_tests.rs` is the only property-based test file in the "
        "workspace (using `proptest`, already a dev-dependency for that crate). `escrow-contract` and `dao-"
        "governance-contract` — the latter being the most state-machine-complex contract in the repo "
        "(Discussion → SnapshotVote → Execution → Executed/Defeated, with lock/extend/withdraw operations "
        "interacting across that lifecycle) — have none. The voting-power-inflation bug found in this audit "
        "is exactly the kind of subtle, sequence-dependent state-machine bug that property-based/fuzz "
        "testing (generating random sequences of lock/extend/snapshot/vote operations and checking "
        "invariants) is well-suited to catch."
    ),
    approach=(
        "Add proptest-based fuzz test suites for escrow-contract (job lifecycle sequences) and dao-"
        "governance-contract (lock/extend/vote/execute sequences), checking invariants like \"a voter's "
        "counted power never exceeds what they held at the relevant snapshot\"."
    ),
    acceptance=[
        "escrow-contract gets a fuzz test suite covering randomized job lifecycle sequences.",
        "dao-governance-contract gets a fuzz test suite covering randomized lock/extend/vote/execute sequences.",
        "The dao-governance-contract fuzz suite includes an invariant check that would have caught the voting-power-inflation bug found this session.",
    ],
    files=["contracts/escrow-contract", "contracts/dao-governance-contract", "contracts/greenpay-contract/src/fuzz_tests.rs"],
),

dict(
    area="Cross-cutting",
    title="No automated check that CI-relevant CLAUDE.md-style contributor conventions stay consistent with actual enforced tooling",
    summary="Multiple ESLint/Prettier/formatting conventions are enforced inconsistently across backend, frontend, contracts, mobile, and extension, with no single contributor-facing document describing the actual, current lint/format/test commands per subproject — a real onboarding friction point.",
    details=(
        "Each subproject (`backend/`, `frontend/`, `contracts/`, `mobile/`, `extension/`) has its own lint/"
        "format/test tooling and conventions (ESLint configs of different vintages, `cargo fmt`/`clippy` for "
        "Rust, no linting at all visible for the Go scheduler beyond `go vet`/build). A new contributor "
        "picking up one of the complex issues in this very batch has no single reference documenting \"here's "
        "how to run tests/lint/build for each of the 7 subprojects\" — `docs/getting-started.md` should be "
        "checked and, if it doesn't already, should cover this consistently including the Go scheduler and "
        "browser extension, which are easy to overlook."
    ),
    approach=(
        "Audit docs/getting-started.md (and CONTRIBUTING.md) for completeness across all seven subprojects "
        "and ensure each has a documented lint/test/build command sequence, including the two most easily "
        "overlooked ones (scheduler, extension)."
    ),
    acceptance=[
        "docs/getting-started.md documents lint/test/build commands for all seven subprojects, including scheduler and extension.",
        "A new contributor can follow the doc to successfully run tests locally for any subproject without prior context.",
        "CONTRIBUTING.md cross-references this consistently.",
    ],
    files=["docs/getting-started.md", "docs/CONTRIBUTING.md"],
),

dict(
    area="Cross-cutting",
    title="No dependency-injection or shared-client pattern — the same Stellar SDK client-construction logic is duplicated across backend, frontend, mobile, and extension",
    summary="Horizon/Soroban RPC client instantiation, network passphrase resolution, and contract-address configuration are independently implemented in at least four codebases, with no shared package — increasing the surface area for exactly the kind of network-passphrase mismatch bug found in mobile this session.",
    details=(
        "`backend/src/services/stellar.js`, `frontend/lib/stellar.ts`, `mobile`'s equivalent Stellar-"
        "interaction code, and `extension/src/popup.ts` each independently construct Horizon/RPC server "
        "clients and resolve network passphrases/contract IDs from their own env-var conventions "
        "(`NEXT_PUBLIC_STELLAR_NETWORK`, `EXPO_PUBLIC_STELLAR_NETWORK`, etc. — all differently named). This "
        "session found a real bug in exactly this category (mobile's donate flow hardcoding `Networks."
        "TESTNET` instead of using its own correct helper) — with four independent implementations of the "
        "same underlying client-construction logic, that class of bug can recur independently in any of "
        "them at any time with no shared fix propagation."
    ),
    approach=(
        "Extract a shared, minimal \"Stellar client factory\" package (network passphrase resolution, "
        "Horizon/RPC client construction, contract ID resolution) usable across backend, frontend, mobile, "
        "and extension, or at minimum a documented canonical pattern each must follow."
    ),
    acceptance=[
        "A shared Stellar-client-construction pattern (package or documented canonical implementation) exists.",
        "All four codebases are migrated to use it consistently.",
        "A test proves network-passphrase resolution is consistent across all four for the same underlying env configuration.",
    ],
    files=["backend/src/services/stellar.js", "frontend/lib/stellar.ts", "mobile", "extension/src"],
),

dict(
    area="Cross-cutting",
    title="No automated accessibility testing beyond three fixed pages in the web frontend — mobile and extension have none",
    summary="frontend/e2e/a11y.spec.ts covers only the home, project-detail, and donor-profile pages using axe-playwright; there's no equivalent accessibility testing for the admin dashboard, donate flow, mobile app, or browser extension popup.",
    details=(
        "`frontend/e2e/a11y.spec.ts` runs `@axe-core/playwright` against exactly three pages. High-traffic, "
        "high-stakes flows like the actual donate form (`/donate/[id]`), the admin dashboard, and the "
        "project-submission flow have no automated accessibility coverage at all in the web frontend, and "
        "neither the mobile app nor the browser extension popup has any accessibility testing whatsoever — "
        "despite this being a donation platform where excluding users with disabilities from actually "
        "completing a donation is a direct product/legal risk, not just a nice-to-have."
    ),
    approach=(
        "Extend axe-playwright coverage to the donate flow and admin dashboard in the web frontend, and "
        "introduce accessibility testing (e.g. via `expo-a11y`-style tooling or manual audit checklist) for "
        "mobile and the extension popup."
    ),
    acceptance=[
        "Web frontend a11y.spec.ts covers the donate flow and admin dashboard, not just three static pages.",
        "Mobile app has some form of automated or documented-manual accessibility testing for its core flows.",
        "The extension popup has an accessibility audit (automated or documented manual) at least once, with findings tracked.",
    ],
    files=["frontend/e2e/a11y.spec.ts", "mobile", "extension"],
),

]  # END_CROSS_CUTTING_MARKER — total should be 100


if __name__ == "__main__":
    main()
