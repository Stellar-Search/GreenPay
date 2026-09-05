# The First-Donation Funnel

How conversion is measured, and against what.

The entire justification for graduated onboarding is that more people reach a
completed donation. That is a measurable claim, and without measurement it stays
an opinion — which is how a change that makes things *worse* survives, because
the team that shipped it likes it.

So the funnel is instrumented on **every** path, including the pre-change
connected-wallet flow, emitting the same stage names. Comparing a new
measurement against an old measurement taken a different way is the most common
way this kind of analysis lies.

## Stages

Ordered. Conversion between adjacent stages is what identifies *where* people
leave, so a stage inserted in the wrong place silently reattributes a drop-off to
its neighbour.

| # | Stage | Reached when |
|---|---|---|
| 0 | `donate_intent` | Donor is on a page from which donating is possible |
| 1 | `path_offered` | Donor was shown the choice of paths |
| 2 | `path_selected` | Donor picked one |
| 3 | `tradeoff_acknowledged` | Donor read and accepted that path's trade-offs |
| 4 | `account_ready` | A usable account exists (connected, or created) |
| 5 | `funds_available` | The account can afford to donate |
| 6 | `donation_submitted` | Donor pressed donate |
| 7 | `donation_confirmed` | Transaction confirmed on-chain |
| 8 | `donation_recorded` | Backend recorded it — the success terminus |

`tradeoff_acknowledged` sits **before** `account_ready` deliberately. If it came
after, the disclosure would be a confirmation rather than a decision, which is
precisely the failure this feature exists to avoid. `funnel.test.js` asserts the
ordering.

## Paths

| Path | Donor |
|---|---|
| `connected_wallet` | Has a wallet and a funded account. The pre-change flow, and the baseline. |
| `sponsored_account` | Has (or will have) an asset but no account. |
| `onramp` | Has neither. |
| `claimable_balance` | Value committed before the account exists. |

## What is deliberately not collected

- No IP addresses. No user agents. No cookies. No cross-site identifiers.
- No device id, push token, or advertising id on mobile.
- Referrers are **bucketed** (`social`, `search`, `internal`, `external`,
  `direct`, `qr`, `email`, `unknown`), never stored verbatim. "Where did they
  come from" is answerable with a handful of categories; a raw URL is a tracking
  identifier.
- The session id is a random value with no derivation from the person, and it
  does not survive the donor clearing their storage.

This is enough to compute stage-to-stage conversion, which is the only question
being asked, and not enough to identify anyone. Instrumenting a donation funnel
is not a licence to build a profile.

## Guarantees the client holds itself to

1. **Telemetry can never break a donation.** Every call is fire-and-forget and
   swallows its own failures. A telemetry outage that stopped people donating
   would be a spectacular own goal for a feature justified by conversion.
2. **Stages are idempotent** per `(session, stage, path)`. A component that
   re-renders must not inflate its own conversion rate; re-reporting updates a
   timestamp rather than adding a row.
3. **Concurrent callers share one session.** A page that mounts three
   instrumented components would otherwise open three sessions and divide its own
   conversion rate by three.
4. **Mobile stays silent when offline.** The donate screen makes a hard promise
   that going offline costs the donor nothing and touches the network not at all.
   A telemetry request underneath that promise breaks it, wastes a radio wake on
   a request that cannot succeed, and on a metered connection spends the donor's
   money to record that they tried to spend their money.

   The consequence is stated rather than hidden: **offline mobile sessions are
   under-counted, not deferred.** A queued donation still reports its later
   stages when completed online, so the funnel's terminus stays accurate; what is
   lost is the intermediate stages of an offline attempt. Mobile conversion is
   therefore a slight *under*-estimate, which is the safe direction for a number
   used to justify the work that produced it.
5. **Mobile telemetry does not share the API client.** It has different semantics
   from a donation — no retries, no error surfacing, a hard 4s timeout, no
   business meaning if dropped. Sharing the axios instance would make it
   indistinguishable from a real API call to anything counting them, including
   the donation flow's own reconciliation logic.

## Reading the numbers

```bash
# Current conversion, with the biggest drop-offs named
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://api.example/api/v1/onboarding/funnel/conversion"

# Against the pre-change baseline
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://api.example/api/v1/onboarding/funnel/conversion?\
baselineSince=2026-01-01T00:00:00Z&baselineUntil=2026-02-01T00:00:00Z&\
since=2026-02-01T00:00:00Z"
```

Admin-only: publishing exactly where donors give up also publishes where to aim
an attack.

### Percentage points, not just relative change

A move from 2% to 3% is **+1 percentage point** and **+50% relative**. Quoting
only the second turns a rounding-level change into a triumph, so the comparison
returns both:

```json
{
  "baseline": { "conversionPct": 2 },
  "current":  { "conversionPct": 3 },
  "deltaPercentagePoints": 1,
  "relativeChangePct": 50,
  "sufficientSample": true
}
```

`sufficientSample` is false below 100 `donate_intent` events in either window.
A conversion number computed from a handful of sessions is noise, and saying so
in the payload is cheaper than explaining it after someone has acted on it.

### Where people leave

`biggestDropOffs` ranks stage transitions by absolute sessions lost. That is the
list to work from — a 10% drop at a stage 900 people reach matters more than a
50% drop at one that 20 reach.

## Establishing the baseline

The pre-change flow emits `donate_intent`, `account_ready`,
`donation_submitted`, `donation_confirmed` and `donation_recorded` under
`connected_wallet`. Deploy the instrumentation, let it run long enough for
`sufficientSample` to be true on the `connected_wallet` path, and use that window
as `baselineSince`/`baselineUntil`.

Judging the change means asking two questions, not one:

1. Did **overall** conversion rise? (Did the new paths add donors?)
2. Did **`connected_wallet`** conversion hold? (Did they cost existing ones?)

A rise in (1) paid for by a fall in (2) is not a win.

## Housekeeping

Sessions left `in_progress` forever inflate conversion by removing people who
left from the failure side of the denominator. `sweepAbandonedSessions` closes
anything untouched for 24 hours, on an hourly interval from
`services/onboarding/maintenance.js`. Its timers are `unref`'d so no test, CLI
script, or migration run is held open by them.

## See also

- [ADR-005](adr/ADR-005-graduated-non-custodial-donor-onboarding.md)
- [docs/sponsorship-economics.md](sponsorship-economics.md)
- [docs/data-retention-policy.md](data-retention-policy.md)
