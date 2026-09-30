# Donation integrity policy and operations

**Owner:** Trust and Safety with Data Engineering

**Policy version:** `donation-integrity-v1`

**Effective:** 2026-08-28

## Purpose

Leaderboard position, project funding totals, and impact figures must not reward a
wallet for moving funds in a loop or donating to a project it controls. Wallet
addresses remain pseudonymous, so the detector produces evidence-bearing signals
and confidence scores rather than identity or fraud verdicts. A signal can open a
human review. It never penalises, suspends, or publicly labels a donor account.

## Applicable rules

A reviewer can apply this policy mechanically:

1. **Self-donation:** the donor address is an active recipient, owner, operator,
   treasury, beneficiary, or declared related wallet for the receiving project.
   A relationship must include provenance and evidence. The project's configured
   recipient wallet is registered automatically.
2. **Rapid repeated pair:** the same donor/project pair produces at least three
   donations in a short bounded window. Repeated identical amounts increase the
   signal confidence but do not establish misconduct.
3. **Circular flow:** a recent on-chain path of at most three transfers starts at
   a project-controlled wallet and reaches the donor that subsequently funds the
   project. Direct return transfers carry more confidence than longer paths.
4. **Combination:** independent signals combine probabilistically. Evidence,
   path, depth, window, relationship provenance, and confidence are retained for
   review.

Legitimate explanations include refunds, treasury consolidation, matching
programmes, custodial accounts, payroll, and accidental duplicate submissions.
Reviewers must consider those explanations before confirming a case.

## Threshold disclosure position

The platform takes a transparency-first position: the signal categories, live
weights, boundaries, graph limits, retention period, evaluation gate, and
enforcement consequences are public. The current version uses:

- review score: **0.70**, combining signals as `1 - product(1 - confidence)`;
- self-donation confidence: the active relationship record's confidence;
- rapid pair: at least **3 donations in 10 minutes**, starting at **0.62**;
  **5** raises it to **0.80**, **10** to **0.93**, and three repeated equal
  amounts add **0.07** up to **0.96**;
- circular path: **0.92** at one hop, **0.82** at two hops, and **0.72** at
  three hops, within a donation-centred **24-hour** window;
- relevant flow retention: **72 hours**.

Publishing these values can make threshold avoidance easier, but hiding them in
an open implementation would provide neither secrecy nor accountable policy.
Threshold crossing only opens private human review; it never applies a penalty.
Random below-threshold sampling, combined signals, a labelled-set quality gate,
and appeals limit the cost of gaming. Material parameter changes require a new
policy version, a fresh labelled-set evaluation, reviewer training, and a
changelog entry.

## Address relationships

`project_wallet_relationships` records relationship type, source, confidence,
validity, reviewer, and evidence. It is not a legal identity registry.

- `recipient` relationships are derived from `projects.wallet_address` and
  refreshed continuously, including projects created after migration.
- Additional relationships require reviewer evidence through
  `POST /api/v1/integrity/relationships`.
- Inactive or expired relationships do not create a self-donation signal.
- A relationship correction causes affected assessments to be rescored; it does
  not silently rewrite the audit trail.

## Continuous detection architecture

Both API and on-chain ingestion write a transaction-keyed durable record to
`donation_integrity_queue`. The Horizon and Soroban indexers identify their own
source, so an API record later observed on-chain is upgraded to indexer evidence.
A historical sweep finds `DonationRecorded` events that predate the detector.

The worker:

1. claims up to 100 observations with `FOR UPDATE SKIP LOCKED` every second;
2. scores self-donation, rapid-pair, and circular-flow signals;
3. stores signal evidence and an immutable lifecycle event;
4. routes significant scores to `pending_review`;
5. retries a failed item with bounded backoff without blocking the donation.

The Horizon stream also observes native payments adjacent to a controlled or
watched address. A bounded watchlist propagates project context through at most
three hops. Relevant edges are retained for 72 hours and expired continuously.
This avoids storing the entire public network while still detecting direct and
short circular paths. Soroban donation events enter the same durable scoring
queue.

### Capacity and operating budget

- Sustained design target: **25 donation observations per second**.
- Burst budget: **100 observations claimed per second**.
- CI regression budget: a 100-observation PostgreSQL burst completes within
  **10 seconds** on a shared runner.
- Watchlist ceiling: **50,000 addresses per process** with least-recently-added
  eviction.
- Flow retention: **72 hours**.
- Graph search: **depth 3**, scoped by project and a 24-hour donation-centred
  window.
- Queue alert: pending age over 60 seconds or three consecutive worker errors.
- Storage alert: flow-edge growth exceeds the expected 72-hour rolling window.

The production load test should run at 25 observations/second for one hour and
report queue age, assessments/second, p50/p95/p99 scoring latency, database CPU,
index growth, retries, and missed known fixtures. Deployment stops if p95 queue
age exceeds 60 seconds or the error rate exceeds 0.1%.

## Review lifecycle and audit

`monitoring` → `pending_review` → `confirmed` or `dismissed`

A detector transition only opens review. It leaves all three exclusion flags
false. A reviewer must inspect relationship provenance, transaction links,
amount/timing evidence, project context, and legitimate explanations, then enter
a reason. Every system, reviewer, and appellant action is appended to
`donation_integrity_events` with actor, prior state, next state, reason, and
metadata.

No donor account is suspended or rate-limited by this system. Pending reviews
are private. Public donor labels are not created.

## Labelled-set gate and false-positive measurement

Enforcement starts disabled in `donation_integrity_settings`. Review outcomes do
not change donor-facing totals until an administrator explicitly enables it.
The enable endpoint recomputes metrics from `donation_integrity_labels` and
rejects enablement unless all conditions hold:

- at least 100 independently reviewed labels;
- at least 20 confirmed-abuse and 20 legitimate examples;
- false-positive rate at or below 2%;
- recall at or above 80%.

The evaluation reports true/false positives, true/false negatives, false-positive
rate, recall, policy version, and the exact gate used. `uncertain` labels are
retained but excluded from the binary metric. Labels must be sampled across
project size, donor size, geography, wallet type, direct/indirect paths, API and
indexer sources, and matching/refund scenarios. A reviewer must not label an item
using only the detector score.

Any score-policy change disables enforcement until a fresh labelled evaluation
passes. Operators can disable enforcement immediately without deleting cases or
accounting records.

## Enforcement after human confirmation

Enforcement is applied only when both conditions hold: a human confirms the case
and the labelled-set gate is enabled.

### Leaderboard

The confirmed donation amount is subtracted from the donor's ranking total.
Badges shown by the leaderboard are recomputed from the adjusted total. Other
legitimate donations remain. The donor account itself is not penalised.

### Displayed project and platform totals

Confirmed amounts are excluded from donor-facing funding totals. Gross ledger and
event-store amounts remain immutable for accounting and investigation. Responses
therefore derive trusted display totals rather than deleting or compensating the
underlying transfer.

### Impact figures

Confirmed amounts do not count as impact-supporting donations and do not make a
donor eligible to claim support for a project's outcomes. Environmental outcomes
remain project-level evidence claims and are never multiplied by, or allocated in
proportion to, a donation.

These three decisions are stored separately as
`exclude_from_leaderboard`, `exclude_from_displayed_totals`, and
`exclude_from_impact_figures` so a future policy change cannot silently conflate
them.

## Appeals

An affected donor or active project-related wallet can request a ten-minute,
one-time challenge. The wallet signs the exact challenge, then submits its appeal
and evidence summary. A valid appeal:

- changes the case to `appealed`;
- suspends all three exclusions while review is pending;
- preserves the original decision and every event;
- enters the independent appeal queue.

The original reviewer cannot decide the appeal. A granted appeal changes the case
to `dismissed`. A denied appeal returns it to `confirmed` and restores exclusions
only if enforcement remains enabled. The decision requires a reason. Further
review follows the support escalation process and never overwrites the first
appeal.

## Reviewer and operator endpoints

- `GET /api/v1/integrity/policy` — public policy summary.
- `GET /api/v1/integrity/status` — queue, worker, and enforcement status.
- `POST /api/v1/integrity/relationships` — evidence-backed related wallet.
- `GET /api/v1/integrity/reviews` — private review queue.
- `GET /api/v1/integrity/reviews/:id` — signals, events, and appeals.
- `POST /api/v1/integrity/reviews/:id/decision` — confirm or dismiss.
- `POST /api/v1/integrity/reviews/:id/appeal-challenge` — affected wallet challenge.
- `POST /api/v1/integrity/reviews/:id/appeals` — signed appeal.
- `GET /api/v1/integrity/appeals` — pending appeals.
- `POST /api/v1/integrity/appeals/:id/decision` — independent decision.
- `POST /api/v1/integrity/reviews/:id/label` — labelled evaluation record.
- `GET /api/v1/integrity/evaluation` — false-positive and recall report.
- `POST /api/v1/integrity/enforcement/enable` — gated enablement.
- `POST /api/v1/integrity/enforcement/disable` — immediate rollback switch.

## Known limits and iteration

Wallet splitting, long-delay cycles, paths beyond three hops, private exchange
accounts, and transfers outside the retained adjacency graph can evade a signal.
A relationship can also be incomplete or stale. These limits are why evidence is
scored, why enforcement is human, and why appeals suspend exclusions.

Every month, review false negatives found through manual investigations, sample
low-scoring observations, audit relationship freshness, compare API/indexer source
coverage, and publish aggregate review/appeal metrics without exposing live gaming
boundaries or wallet-level allegations.
