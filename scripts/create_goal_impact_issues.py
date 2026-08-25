#!/usr/bin/env python3
"""
scripts/create_goal_impact_issues.py

Opens five large issues, each tied to a goal this project has already stated
in README.md or docs/ROADMAP.md rather than to a feature idea.

Every issue opens with the goal it serves and the causal chain from the work
to that goal, so the question "why build this" is answered before the design.

Idempotent: fetches every existing issue title first and skips anything
already present, and refuses to run if two issues in this batch share a title.

    python3 scripts/create_goal_impact_issues.py --dry-run
    python3 scripts/create_goal_impact_issues.py
"""
import argparse
import os
import subprocess
import sys
import time

import requests

REPO = "Stellar-Search/GreenPay"
API = f"https://api.github.com/repos/{REPO}"

TOKEN = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
if not TOKEN:
    try:
        TOKEN = subprocess.check_output(["gh", "auth", "token"], text=True).strip()
    except Exception:
        TOKEN = None
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


def existing_titles() -> set:
    titles, page = set(), 1
    while True:
        r = SESSION.get(f"{API}/issues", params={"state": "all", "per_page": 100, "page": page})
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        for it in batch:
            if "pull_request" not in it:
                titles.add(it["title"])
        if len(batch) < 100:
            break
        page += 1
    return titles


def body_for(i: dict) -> str:
    parts = [
        f"> **Goal this serves — {i['goal']}**\n>\n> {i['goal_detail']}",
        "## Why this matters now\n\n" + i["why"],
        "## Evidence in the current codebase\n\n" + i["evidence"],
        "## Why this is hard\n\n" + i["hard"],
        "## Suggested approach\n\n" + i["approach"],
        "## Acceptance criteria\n\n" + "\n".join(f"- [ ] {c}" for c in i["acceptance"]),
        "## Scope\n\n" + i["scope"],
        "## Relevant files\n\n" + "\n".join(f"- `{f}`" for f in i["files"]),
    ]
    if i.get("related"):
        parts.append("## Related\n\n" + i["related"])
    return "\n\n".join(parts)


def create_issue(i: dict, dry_run: bool = False) -> None:
    title = f"{i['area']}: {i['title']}"
    labels = ["complexity: high", i["label"]]
    if i.get("security"):
        labels.append("security")
    if dry_run:
        print(f"    [dry-run] {title}  {labels}")
        return
    r = SESSION.post(f"{API}/issues", json={"title": title, "body": body_for(i), "labels": labels})
    if r.status_code >= 300:
        print(f"    ERROR {r.status_code}: {r.text[:300]}", file=sys.stderr)
        r.raise_for_status()
    print(f"    created #{r.json()['number']}")


ISSUES = [

    # ── 1 ────────────────────────────────────────────────────────────────────
    dict(
        area="Cross-cutting",
        label="area: cross-cutting",
        goal="Radical transparency (README) · v1.5 Impact Dashboard",
        goal_detail=(
            "The README promises *“radical transparency”* and *“Soroban contract tracks every donation "
            "and CO₂ offset.”* The donation half of that is true and verifiable on-chain. The CO₂ half is "
            "not measured, not sourced and not verifiable — it is derived from the donation amount itself."
        ),
        title="Make the CO₂ impact figure a verifiable claim instead of a restatement of the donation amount",
        why=(
            "This is the widest gap between what the project promises and what it does. A donor can "
            "independently verify that 50 XLM reached a project wallet — that is genuinely on-chain. They "
            "cannot verify anything at all about the *climate outcome*, which is the reason they donated.\n\n"
            "Worse, the number shown is circular. It is the donation amount multiplied by a ratio derived "
            "from a figure the project operator typed in. Two donors giving the same amount to the same "
            "project always see the same “impact”, no matter what happened in the world. Nothing about the "
            "figure can change based on measurement, because no measurement is ever taken.\n\n"
            "Every downstream surface inherits this: the leaderboard, the impact page, the certificate a "
            "donor can print and share. Fixing the presentation layer without fixing provenance would just "
            "make an unverifiable claim look more credible."
        ),
        evidence=(
            "```js\n"
            "// backend/src/routes/impact.js:96-97\n"
            "const kgPerXlm   = raisedXlm > 0 ? projectCo2OffsetKg / raisedXlm : 0;\n"
            "const co2OffsetKg = Math.round(totalDonationsXLM * kgPerXlm);\n"
            "```\n\n"
            "`projectCo2OffsetKg` comes from `projects.co2_offset_kg`, a plain column populated by seed data "
            "or an admin form. So the pipeline is: take an unaudited number, divide it by the amount raised "
            "to invent a rate, then multiply that rate back by the donation. **The output carries no "
            "information that was not already in the donation amount.**\n\n"
            "```js\n"
            "// backend/src/routes/impact.js:21\n"
            "const KG_CO2_PER_TREE = 21.77; // heuristic, used for treesEquivalent\n"
            "```\n"
            "The code comment says “heuristic”; the UI presents the result as a fact.\n\n"
            "```js\n"
            "// backend/src/routes/impact.js:104 and :174\n"
            "uniqueCountries: 0,\n"
            "```\n"
            "A dashboard field hardcoded to zero and rendered as though it were data.\n\n"
            "There is no methodology field, no measurement date, no source, no verifier and no evidence "
            "anywhere in `schema.sql` — `co2_offset_kg` is a bare `NUMERIC` on `projects`."
        ),
        hard=(
            "**Carbon accounting has real standards, and they disagree.** Avoided emissions, sequestration "
            "and offsets are not the same quantity and must not be summed into one headline number. A "
            "reforestation project's sequestration accrues over decades with a baseline and a leakage "
            "deduction; a solar project displaces grid emissions at a rate that depends on the local grid. "
            "Modelling that honestly is the core of this work, not a detail.\n\n"
            "**Uncertainty has to survive to the UI.** A claim is a range with a confidence and a vintage, "
            "not a scalar. The moment it is rendered as a single rounded integer the honesty is lost, so the "
            "data model and the components have to carry uncertainty together.\n\n"
            "**Unverified claims must stay visible, not hidden.** Most projects will have no attestation at "
            "first. Suppressing their numbers destroys the product; presenting them identically to verified "
            "ones destroys the point. The interface has to make provenance legible at a glance.\n\n"
            "**Migration is a truth problem, not a data problem.** Every existing figure is unsourced. "
            "Deciding what happens to them — relabelled as operator-stated, withdrawn, or grandfathered — "
            "is a decision to make explicitly and record.\n\n"
            "**Anchoring on-chain is the easy part.** Hashing an attestation into Soroban is straightforward; "
            "deciding who may attest, how an attestation is revoked when it turns out to be wrong, and what "
            "a donor sees when a claim they already shared is later withdrawn, is not."
        ),
        approach=(
            "Model a claim as evidence rather than a number: quantity, unit, methodology, measurement "
            "period, baseline, uncertainty range, who asserted it, who verified it, and when it expires. "
            "Keep the operator's assertion and the verifier's attestation as separate records — conflating "
            "them is what produced the current situation.\n\n"
            "Register methodologies explicitly so a claim states which one it used, and so two projects' "
            "numbers are only ever compared when that comparison is meaningful.\n\n"
            "Anchor the attestation hash on-chain so a donor can confirm that what they are shown is what "
            "was attested, and design revocation from the start rather than bolting it on.\n\n"
            "Surface provenance everywhere a number appears — the project page, the certificate, the "
            "leaderboard — with a clear visual distinction between *verified*, *operator-stated* and "
            "*unverified*. Replace `uniqueCountries: 0` with either a real value or nothing at all."
        ),
        acceptance=[
            "An impact claim records quantity, unit, methodology, measurement period, baseline, uncertainty and asserting party.",
            "Operator assertions and independent verifications are distinct records; one cannot be mistaken for the other.",
            "No displayed impact figure is derived by multiplying the donation amount by a ratio inferred from the same project's own totals.",
            "Avoided emissions, sequestration and offsets are modelled as distinct quantities and are never summed into one headline figure.",
            "Uncertainty is carried through the API and rendered in the UI; no claim is presented as an exact integer when it is a range.",
            "Verified, operator-stated and unverified claims are visually distinguishable everywhere a figure appears, including the printable certificate.",
            "An attestation hash is anchored on-chain and a donor can independently confirm the figure they were shown matches it.",
            "Revocation is implemented, and the behaviour for a donor who already shared a since-withdrawn claim is defined.",
            "`uniqueCountries` returns a real value or is removed — it is not hardcoded to zero.",
            "The treatment of existing unsourced `co2_offset_kg` values is decided and recorded in an ADR under `docs/adr/`.",
            "The chosen carbon-accounting approach is documented for a non-specialist reader, with its limitations stated.",
        ],
        scope=(
            "Roughly **6,000–8,000 lines**: schema and migrations for claims, evidence, methodologies and "
            "attestations; a methodology registry; evidence intake and verifier review flows; the on-chain "
            "anchoring contract and its tests; provenance-aware API responses; UI work across the project "
            "page, impact page, leaderboard and certificate; and migration of existing values."
        ),
        files=[
            "backend/src/routes/impact.js",
            "backend/src/db/schema.sql",
            "contracts/greenpay-contract/src/lib.rs",
            "frontend/pages/impact.tsx",
            "frontend/components/ImpactCertificate.tsx",
            "docs/adr/",
        ],
        related=(
            "Pairs with the impact-dashboard work in v1.5 — aggregation and mapping should be built on the "
            "claim model this issue introduces, not on the current bare column."
        ),
    ),

    # ── 2 ────────────────────────────────────────────────────────────────────
    dict(
        area="Cross-cutting",
        label="area: cross-cutting",
        goal="v2.0 Multi-Currency (ROADMAP) · zero platform fees (README)",
        goal_detail=(
            "The roadmap commits to *“USDC donations alongside XLM”*, *“automatic XLM/USDC conversion via "
            "Stellar DEX”* and *“show donation value in local fiat currency.”* None of it exists: donations "
            "are native XLM only."
        ),
        title="Accept donations in any Stellar asset and settle to what the project holds, using DEX path payments",
        why=(
            "Requiring donors to hold XLM excludes most of them. Someone holding USDC has to find an "
            "exchange, convert, accept the price risk and pay a spread before they can give anything — and "
            "many simply will not. Every donor lost at that step is money that never reaches a climate "
            "project, which is the project's entire purpose.\n\n"
            "Stellar's DEX makes this solvable without an intermediary taking a cut, which is what protects "
            "the *zero platform fees* promise. A path payment converts atomically inside the transaction: "
            "the donor sends what they hold, the project receives what it wants, and no custodial service "
            "sits in the middle holding funds. Doing this with an off-chain conversion service would deliver "
            "the feature and break the promise."
        ),
        evidence=(
            "```sql\n"
            "-- backend/src/db/schema.sql:40\n"
            "currency TEXT NOT NULL DEFAULT 'XLM',\n"
            "```\n"
            "The column exists, so the intent was there. Nothing populates it with anything else.\n\n"
            "```\n"
            "$ git grep -lIiE 'pathPayment|strictSend|strictReceive' -- backend/src contracts\n"
            "(no matches)\n"
            "```\n\n"
            "Every donation path builds `Operation.payment` with `Asset.native()`. The mobile helper "
            "`utils/donationTransaction.ts` hardcodes the native asset, and the frontend does the same. "
            "There is no trustline detection, no quoting, and no slippage handling anywhere.\n\n"
            "Issue #142 reports the symptom — a missing USDC trustline blocking a donation with no in-app "
            "way to fix it — which is a downstream consequence of the capability not existing."
        ),
        hard=(
            "**Two amounts, not one.** A path payment has a sent amount and a received amount, and they are "
            "different numbers in different assets. Everything downstream — totals, the leaderboard, impact "
            "figures, the donor's receipt — has to be explicit about which one it means. Recording a single "
            "`amount` is what makes this class of feature corrupt accounting quietly.\n\n"
            "**Slippage is a correctness problem, not a UX detail.** The path is quoted before signing and "
            "executed after, and the order book moves in between. Strict-send and strict-receive fail in "
            "opposite ways: one can deliver less than promised, the other can cost more than expected. "
            "Choosing per flow, and bounding both, is a design decision the donor has to understand.\n\n"
            "**Trustlines.** A project cannot receive an asset it does not trust, and a donor cannot send "
            "one they do not hold. Both need detection and an in-app path to resolution, including the "
            "reserve requirement a new trustline imposes.\n\n"
            "**Thin markets.** For a small donation in an illiquid pair, the best path may not exist at all "
            "or may be so bad it should be refused. Failing clearly beats executing a terrible conversion.\n\n"
            "**Fiat display is a data-integrity trap.** A rate must be captured at donation time and stored "
            "with the record. Re-deriving historical fiat values from today's rate makes past receipts "
            "silently wrong."
        ),
        approach=(
            "Record sent and received amounts as separate, explicitly named fields with their assets, and "
            "define once — in one place — which of them every existing aggregate refers to. Migrate the "
            "current XLM-only rows into that shape rather than special-casing them.\n\n"
            "Quote the path immediately before signing, show the donor what will be sent and what will "
            "arrive, and carry an explicit bound. Handle the case where no acceptable path exists as a "
            "first-class outcome with a clear explanation, not a generic failure.\n\n"
            "Detect missing trustlines on both sides and offer a real path to resolution in-app, which also "
            "closes #142.\n\n"
            "Capture the fiat rate and its source at donation time and store it on the record."
        ),
        acceptance=[
            "A donor can give in a supported non-native asset and the project receives the asset it holds, in one atomic transaction.",
            "Sent and received amounts are stored as separate named fields with their assets; no aggregate is ambiguous about which it uses.",
            "Existing XLM-only donation rows are migrated into the new shape rather than special-cased.",
            "The donor sees the quoted send and receive amounts, and an explicit bound, before signing.",
            "Strict-send versus strict-receive is chosen deliberately per flow and the reasoning is documented.",
            "A donation with no acceptable path fails with an explanation the donor can act on, and no partial state is left behind.",
            "Missing trustlines are detected on both sides with an in-app resolution path, closing #142.",
            "The fiat rate and its source are captured at donation time and stored on the record; historical receipts do not change when rates move.",
            "No custodial intermediary holds donor funds at any point — the zero-fee promise is preserved and the transaction structure demonstrates it.",
            "Tests cover thin order books, a path that degrades between quote and submission, and a trustline created mid-flow.",
        ],
        scope=(
            "Roughly **6,000–8,000 lines**: path-payment construction across web and mobile, quoting and "
            "slippage bounds, trustline detection and creation flows, schema and migration for dual "
            "amounts, rate capture and storage, updates to every aggregate that reads donation amounts, "
            "and tests against a local network with seeded order books."
        ),
        files=[
            "frontend/lib/stellar.ts",
            "frontend/components/DonateForm.tsx",
            "mobile/utils/donationTransaction.ts",
            "backend/src/db/schema.sql",
            "backend/src/routes/donations.js",
            "backend/src/services/indexerService.js",
        ],
        related="Closes #142 as a consequence of building the underlying capability.",
    ),

    # ── 3 ────────────────────────────────────────────────────────────────────
    dict(
        area="Contracts",
        label="area: contracts",
        goal="v1.2 Verified Projects · v2.1 DAO Governance (ROADMAP)",
        goal_detail=(
            "The roadmap commits to a *“verified badge with on-chain proof”* and to *“community vote on "
            "which projects get verified”* with *“donor voting power proportional to total donated.”* Today "
            "a project becomes verified when a single admin sets a boolean."
        ),
        title="Make project verification an evidenced, community-governed process with on-chain proof and revocation",
        why=(
            "*Verified* is the word doing the most work on this platform. It is why a donor trusts a project "
            "enough to send money to a wallet address they have never seen. Right now it means one "
            "administrator holding a JWT flipped a column — there is no application, no evidence, no record "
            "of who decided or why, no way for the community to participate, and no way to take it back if "
            "a project turns out to be fraudulent.\n\n"
            "That is a single point of both failure and compromise. If that credential leaks, an attacker "
            "marks their own wallet as a verified climate project and donations flow to it. Nothing on-chain "
            "would contradict them, because the badge has no on-chain proof behind it.\n\n"
            "The governance machinery to fix this already exists in the repository. What is missing is the "
            "pipeline connecting an application to a decision to a provable badge."
        ),
        evidence=(
            "```js\n"
            "// backend/src/routes/projects.js:434-435\n"
            "SET on_chain_verified = true,\n"
            "    verified = true,\n"
            "```\n"
            "Verification is a column update behind an admin JWT. There is no application record, no "
            "evidence attached, no decision log and no revocation path.\n\n"
            "```sql\n"
            "-- backend/src/db/schema.sql:14\n"
            "on_chain_verified BOOLEAN NOT NULL DEFAULT FALSE,\n"
            "```\n"
            "The column implies a proof exists. Nothing links a verified project to a specific on-chain "
            "decision that a third party could check.\n\n"
            "A DAO contract, stake-weighted voting and Sybil resistance already exist under `contracts/`. "
            "Issues #112, #113 and #317 document that two parallel verification paths coexist and that the "
            "legacy badge-holder path is still live — so the primitives are there, but nothing binds them "
            "into the flow the roadmap describes."
        ),
        hard=(
            "**Evidence, not vibes.** A verification decision needs something to decide *on*: legal "
            "identity, wallet control, project documentation. Wallet control is provable cryptographically; "
            "the rest is not, and the design has to be honest about which parts of *verified* are proven and "
            "which are attested by humans.\n\n"
            "**Revocation is harder than granting.** A project may be verified, receive donations, and later "
            "be exposed. What happens to its badge, to funds already sent, to the donors who gave on the "
            "strength of it, and to their impact claims? A design without revocation is not a verification "
            "system.\n\n"
            "**Voter incentives.** Stake-weighted voting concentrates power in large donors, who may be the "
            "very projects seeking verification. #113 already found the Sybil hole. Quorum, turnout and "
            "abstention all need answers that survive an adversary.\n\n"
            "**Two live paths must become one.** Migrating without breaking already-verified projects, and "
            "retiring the legacy path rather than leaving it as a bypass, is most of the risk.\n\n"
            "**Privacy.** Verification evidence may include documents that cannot be published, but the "
            "decision must be publicly checkable. Commit to a hash on-chain and keep the document off it."
        ),
        approach=(
            "Model the full lifecycle: application, evidence submission, review, community vote, on-chain "
            "decision, badge issuance, expiry and revocation. Every state transition should leave a record "
            "that names who acted and why.\n\n"
            "Prove wallet control cryptographically — a signature from the project wallet — and treat the "
            "remaining criteria as human attestations, labelled as such.\n\n"
            "Anchor the decision on-chain so a donor can verify a badge independently of this platform's "
            "API, and give the badge an expiry so verification is renewed rather than granted forever.\n\n"
            "Consolidate onto one path and remove the legacy one, migrating existing verified projects with "
            "a recorded rationale for each."
        ),
        acceptance=[
            "A project applies, submits evidence, and the application moves through recorded states to a decision.",
            "Control of the project wallet is proven by signature, and criteria that are human judgement are labelled as attestations rather than proofs.",
            "The decision is anchored on-chain and a donor can verify a badge without trusting this platform's API.",
            "Revocation is implemented end to end, including what donors who already gave are told and what happens to affected impact claims.",
            "Badges expire and require renewal; expiry behaviour is visible in the UI before it happens.",
            "Voting is stake-weighted with documented answers for quorum, turnout, abstention and self-dealing by an applicant.",
            "The legacy badge-holder verification path is removed, not left alongside — closing the bypass described in #317.",
            "Existing verified projects are migrated with a recorded rationale for each.",
            "Evidence that cannot be published is committed by hash on-chain while the document stays private.",
            "No single credential can mark a project verified on its own.",
        ],
        scope=(
            "Roughly **6,000–8,000 lines**: contract work for decisions, badges, expiry and revocation with "
            "tests; application and evidence models with migrations; the review and voting flows; wallet "
            "proof-of-control; public verification tooling; UI for applicants, voters and donors; and "
            "migration off the legacy path."
        ),
        files=[
            "contracts/greenpay-contract/src/lib.rs",
            "contracts/dao-governance-contract/src/lib.rs",
            "backend/src/routes/projects.js",
            "backend/src/db/schema.sql",
            "frontend/pages/admin/[projectId].tsx",
        ],
        related="Builds on #112, #113 and #317, which describe the fragments this issue would unify.",
        security=True,
    ),

    # ── 4 ────────────────────────────────────────────────────────────────────
    dict(
        area="Cross-cutting",
        label="area: cross-cutting",
        goal="v1.4 Community Features (ROADMAP) · sustained funding for projects",
        goal_detail=(
            "The roadmap lists recurring giving and a *“monthly impact digest.”* Recurring donations are "
            "currently a local phone reminder that fires a notification and asks the donor to do it again "
            "by hand."
        ),
        title="Make recurring giving actually recur, without the platform ever holding donor keys",
        why=(
            "Climate projects need funding they can plan against. A reforestation programme cannot hire "
            "planters on the strength of donations that may or may not arrive. Recurring revenue is the "
            "difference between a project that can commit to work and one that cannot — which makes this "
            "one of the most direct levers on the platform's actual purpose.\n\n"
            "What exists today does not do that. It schedules a local push notification and asks the donor "
            "to repeat the donation manually. Every cycle depends on someone seeing a notification, opening "
            "the app, and signing again. Attrition through that funnel is severe, and the project sees none "
            "of the predictability the feature is supposed to create.\n\n"
            "The constraint that makes this interesting is that the platform must never hold donor keys. "
            "Custody would make recurring trivial and would betray the non-custodial design the whole "
            "product rests on. Stellar has primitives for this; using them correctly is the work."
        ),
        evidence=(
            "```ts\n"
            "// mobile/utils/recurringDonations.ts:7\n"
            "// reminders only — when nextDueDate arrives we fire a local push notification\n"
            "\n"
            "// mobile/utils/recurringDonations.ts:137\n"
            "// Seconds-from-now local trigger — no auto-signing, just a reminder.\n"
            "```\n\n"
            "The comments are explicit: nothing is executed. A schedule exists, a reminder fires, and the "
            "donor is asked to donate again by hand.\n\n"
            "`backend/src/utils/recurringSchedule.js` computes due dates and "
            "`frontend/components/MonthlyGivingSetup.tsx` collects a schedule, but no component anywhere "
            "submits a recurring payment. If the donor uninstalls the app or ignores the notification, the "
            "commitment silently ends and nothing tells the project."
        ),
        hard=(
            "**Non-custodial recurrence is the whole problem.** The obvious solutions all require holding a "
            "key. The design has to work within what Stellar actually offers — pre-authorized transactions, "
            "constrained signers, claimable balances — each with different trade-offs in revocability, "
            "expiry and what happens when the donor's balance is short. Choosing among them, and being "
            "honest about what the donor is authorizing, is the core of this issue.\n\n"
            "**Revocation must be immediate and obvious.** A donor who cannot confidently stop a recurring "
            "commitment will never start one. Cancellation has to take effect without depending on the "
            "platform's cooperation.\n\n"
            "**Failures are normal, not exceptional.** Insufficient balance, a removed trustline, an expired "
            "authorization. Each needs a retry policy, donor communication, and a defined point at which the "
            "commitment lapses rather than retrying forever.\n\n"
            "**Calendar correctness.** Monthly on the 31st, daylight-saving transitions, and timezone "
            "handling all have to be decided rather than inherited from whatever the runtime does.\n\n"
            "**Exactly-once.** A retry that double-charges a donor is far worse than one that skips a cycle."
        ),
        approach=(
            "Start by choosing the authorization primitive and documenting the trade-off, because "
            "everything else follows from it. Whatever is chosen, the donor must be able to see exactly what "
            "they authorized and revoke it independently of this platform.\n\n"
            "Build execution as a queue with explicit terminal states rather than a loop that retries "
            "forever, and make each cycle idempotent so a retry cannot double-charge.\n\n"
            "Store instants in UTC alongside the donor's intended local timezone so a monthly gift stays on "
            "the same local date across daylight-saving changes, and define month-end behaviour explicitly.\n\n"
            "Close the loop with the digest the roadmap asks for — and report *verified* impact where it "
            "exists, so the digest strengthens the transparency promise instead of restating unsourced "
            "numbers."
        ),
        acceptance=[
            "A recurring commitment executes without the donor manually signing each cycle, and the platform never holds a donor key.",
            "The authorization primitive is chosen with its trade-offs documented in an ADR under `docs/adr/`.",
            "The donor sees exactly what they authorized, including its limits and expiry, before confirming.",
            "Cancellation takes effect immediately and does not depend on the platform's cooperation.",
            "Insufficient balance, removed trustline and expired authorization each have a defined retry policy and a defined point of lapse.",
            "Execution is idempotent: a retried cycle cannot charge twice, proven by a concurrency test.",
            "Monthly schedules behave correctly on the 31st and across both daylight-saving transitions, covered by tests.",
            "A project can see committed recurring revenue distinctly from one-off donations.",
            "The monthly digest reports verified impact where it exists and is clearly labelled where it does not.",
            "The digest has a working unsubscribe that does not cancel the donation itself.",
        ],
        scope=(
            "Roughly **6,000–8,000 lines**: the authorization mechanism and its Stellar integration, an "
            "execution engine with retry and terminal states, schema and migrations for commitments and "
            "cycles, timezone-correct scheduling, donor-facing management UI on web and mobile, digest "
            "generation and delivery, and tests for the failure and calendar cases."
        ),
        files=[
            "mobile/utils/recurringDonations.ts",
            "backend/src/utils/recurringSchedule.js",
            "frontend/components/MonthlyGivingSetup.tsx",
            "backend/src/services/email.js",
            "docs/monthly-giving-scheduling.md",
            "docs/adr/",
        ],
        related="The digest should consume the verified-claim model rather than the current unsourced figures.",
    ),

    # ── 5 ────────────────────────────────────────────────────────────────────
    dict(
        area="Frontend",
        label="area: frontend",
        goal="Donations reaching climate projects (README) — removing the largest funnel blocker",
        goal_detail=(
            "The platform's purpose is getting money to verified climate projects. Today a first-time donor "
            "must already have a browser extension installed and a funded Stellar account before they can "
            "give anything at all."
        ),
        title="Let a first-time donor give without already owning a funded Stellar wallet",
        why=(
            "Every other issue here improves something for people who can already donate. This one "
            "determines how many people that is.\n\n"
            "The current first-donation path asks someone who wants to support reforestation to install a "
            "browser extension, understand seed phrases, acquire XLM on an exchange, wait for it to settle, "
            "fund a new account past the base reserve, and only then donate. Each of those is a step where "
            "well-intentioned people leave. The platform can be flawless after that step and still receive "
            "almost nothing, because almost nobody reaches it.\n\n"
            "This is the highest-leverage work in the repository for the project's stated purpose, and it is "
            "entirely unbuilt. It is also the one most likely to be done badly: the shortcuts all involve "
            "custody, and custody would contradict the design the rest of the platform depends on."
        ),
        evidence=(
            "```\n"
            "$ git grep -lIiE 'claimableBalance|beginSponsoring|sep-?24|onramp' -- backend/src frontend mobile\n"
            "frontend/lib/stellar.ts        # friendbot only, testnet\n"
            "```\n\n"
            "No sponsored account creation, no claimable balances, no on-ramp integration, and no path for a "
            "donor without an existing wallet. `frontend/components/WalletConnect.tsx` and the mobile "
            "equivalent both assume a wallet already exists and is funded — the only branch for a donor "
            "without one is an instruction to go and get one.\n\n"
            "The base reserve makes this concrete: a brand-new Stellar account cannot exist at all until "
            "someone funds it past the minimum balance, so the very first donation is blocked by a "
            "requirement that has nothing to do with donating."
        ),
        hard=(
            "**Custody is the trap.** Every quick answer — hold funds, hold keys, donate on the user's "
            "behalf — makes onboarding easy and makes the platform a custodian, contradicting the "
            "non-custodial guarantee everything else rests on, and carrying regulatory weight the project "
            "has not signed up for. The design has to stay non-custodial while removing the friction.\n\n"
            "**Sponsored reserves are a commitment, not a trick.** Sponsoring account creation means the "
            "platform locks XLM per account, recoverable only if the sponsorship is later revoked. That is a "
            "real cost with a real abuse surface, and it needs limits and a recovery story.\n\n"
            "**Key custody by the user is the actual UX problem.** A donor who loses their key loses their "
            "donation history and any badge they earned. Recovery options each trade off security against "
            "usability, and the honest answer may be to make the first donation possible without a "
            "persistent account at all.\n\n"
            "**On-ramps bring compliance.** Any fiat path introduces KYC, jurisdictional limits and a "
            "provider relationship. What the platform takes on versus delegates has to be an explicit "
            "decision.\n\n"
            "**It must not become a laundering path.** Anonymous funding that moves value to an arbitrary "
            "address needs limits and monitoring designed in from the start."
        ),
        approach=(
            "Treat this as several graduated paths rather than one, and let the donor's situation select "
            "among them: a donor who already has a wallet keeps today's flow untouched; a donor with an "
            "asset but no account gets sponsored creation; a donor with neither gets an on-ramp or a "
            "claimable-balance path that does not require an account to exist first.\n\n"
            "Prototype the sponsorship economics before building the UI — the per-account reserve cost and "
            "its abuse limits determine whether the approach is viable at all, and that should be settled "
            "early rather than discovered late.\n\n"
            "Make the trade-off visible to the donor rather than hiding it. People will accept a constrained "
            "first donation if they understand what they are getting; they will not forgive discovering "
            "later that they cannot recover something they thought they owned.\n\n"
            "Instrument the funnel, because the entire justification for this work is conversion and it "
            "should be measured rather than assumed."
        ),
        acceptance=[
            "A donor with no wallet and no XLM can complete a donation, and the platform holds neither their keys nor their funds at any point.",
            "The existing flow for donors who already have a funded wallet is unchanged.",
            "Sponsored account creation, if used, has documented per-account cost, rate limits, an abuse policy and a recovery path for locked reserves.",
            "What the donor is trading off — recoverability, portability, history — is stated plainly before they commit, not afterwards.",
            "Any fiat on-ramp integration records which compliance obligations sit with the provider and which with the platform.",
            "Abuse limits and monitoring are designed in, with the laundering surface explicitly assessed.",
            "A donor who later obtains a full wallet can carry their donation history and badges across, or the limitation is stated up front.",
            "The funnel is instrumented end to end so conversion can be measured against the pre-change baseline.",
            "The chosen approach and the alternatives rejected are recorded in an ADR under `docs/adr/`.",
            "Tests cover the base-reserve boundary, a sponsorship that fails mid-flow, and an abandoned donation leaving no partial state.",
        ],
        scope=(
            "Roughly **6,000–8,000 lines**: sponsored account creation and its reserve accounting, a "
            "claimable-balance or on-ramp path, graduated onboarding flows on web and mobile, abuse limits "
            "and monitoring, account upgrade and history migration, funnel instrumentation, and tests "
            "against a local network."
        ),
        files=[
            "frontend/components/WalletConnect.tsx",
            "frontend/components/DonateForm.tsx",
            "frontend/lib/stellar.ts",
            "mobile/src/components/WalletConnect.tsx",
            "backend/src/routes/donations.js",
            "docs/adr/",
        ],
        security=True,
    ),
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--sleep", type=float, default=1.2)
    args = parser.parse_args()

    print(f"Repo: {REPO}\nIssues defined: {len(ISSUES)}")

    titles = [f"{i['area']}: {i['title']}" for i in ISSUES]
    if len(set(titles)) != len(titles):
        dupes = {t for t in titles if titles.count(t) > 1}
        print(f"ERROR: duplicate titles within this batch: {dupes}", file=sys.stderr)
        sys.exit(1)

    print("Fetching existing issue titles (so nothing is duplicated)...")
    already = existing_titles()
    print(f"  {len(already)} issues already in the tracker — these will be left untouched.")

    created = skipped = 0
    for idx, issue in enumerate(ISSUES):
        full = f"{issue['area']}: {issue['title']}"
        if full in already:
            print(f"  [{idx}] skip (already exists): {full}")
            skipped += 1
            continue
        print(f"  [{idx}] {full}")
        create_issue(issue, dry_run=args.dry_run)
        created += 1
        if not args.dry_run:
            time.sleep(args.sleep)

    print(f"\nDone. Created: {created}, skipped as existing: {skipped}")


if __name__ == "__main__":
    main()
