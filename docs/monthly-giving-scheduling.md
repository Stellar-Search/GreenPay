# Recurring Donation ("Monthly Giving") Scheduling

This document explains how GreenPay computes "next charge date" for
recurring monthly donations, why it does it that way, and where the logic
lives. It exists because recurring-date math across month-length
differences and DST transitions is a classic source of silent bugs (skipped
cycles, double charges, or a subscription quietly drifting off its intended
day) — this doc is the single place both the frontend and backend should
point to so their behavior can never disagree.

## Audit findings (as of this change)

1. **`backend/src/routes/subscriptions.js` does not execute recurring
   donations.** Despite the name, it implements donor sign-ups for
   project-update emails (backed by the `project_subscriptions` table) — an
   unrelated feature that happens to share the word "subscription". There is
   no DB table, route, or job anywhere in the backend that stores or
   executes monthly-giving charges. `frontend/lib/monthlyGiving.ts` is the
   entire implementation today: subscriptions live in the donor's browser
   `localStorage`, and a "charge" is simulated client-side by calling
   `markMonthlySubscriptionPaid` after a normal one-off donation transaction
   succeeds.
2. **The classic "naive `Date.setMonth` rollover" bug was *not* present.**
   The original `addMonths` helper already pinned arithmetic to UTC
   calendar fields (`setUTCDate(1)` before `setUTCMonth(...)`), so
   Jan 31 + 1 month correctly clamped to Feb 29/28 instead of rolling into
   March.
3. **A different, real month-length bug *was* present: anchor-day drift.**
   `addMonths` derived the day to clamp *from the previous cycle's
   (possibly already-clamped) date*, not from the donor's original pick.
   Concretely, a subscription created for Jan 31 followed this sequence:
   `Jan 31 → Feb 29 → Mar 29 → Apr 29 → ...` — once a short month clamped the
   day down, the subscription permanently lost its original "31st" anchor
   and never saw the 31st again, even in months that have one. The fix
   below stores the anchor day immutably and always clamps from it.
4. **A real timezone bug was present:** the UI's date picker produces a
   plain `YYYY-MM-DD` string, which was being converted via
   `new Date(startDate).toISOString()`. A date-only string like
   `"2024-01-31"` parses as UTC midnight, so a donor west of UTC (e.g. any
   US timezone) would see `nextDueDate` displayed as *Jan 30* on their own
   clock, not the 31st they picked. Nothing tracked which timezone a
   subscription was created in, so this offset could also silently change
   between winter/summer as the donor's UTC offset shifted with DST.

## Canonical rule: donor-local calendar day

For a donation platform, donor expectation ("charge me on the 1st") matters
more than backend/infra convenience. We chose **donor-local calendar
semantics**, not a fixed UTC instant:

- Every subscription stores an immutable **`anchorDay`** (1-31, the calendar
  day the donor originally picked) and an IANA **`timeZone`** (captured from
  the donor's browser via `Intl.DateTimeFormat().resolvedOptions().timeZone`
  at creation time).
- Every cycle's charge is scheduled for `anchorDay` at a fixed donor-local
  time of day — **09:00** (`CHARGE_LOCAL_HOUR`) — in that timezone. 09:00 is
  chosen specifically because it falls well outside the ~1-3am window where
  DST transitions make local time ambiguous or nonexistent, so we never have
  to reason about "what if the wall-clock charge time doesn't exist today."
- The concrete UTC instant used for storage/comparison (`nextDueDate`) is
  *derived* from `(anchorDay, timeZone)` on every cycle — it is never
  produced by adding a fixed millisecond duration to the previous instant.

### Month-length clamping rule

If the target month is shorter than `anchorDay` (e.g. anchor 31 in a 30-day
month, or 29/30/31 in February), clamp to the **last day of that month**:

```
Jan 31 → Feb 28 (or 29 in a leap year) → Mar 31 → Apr 30 → May 31 → ...
```

The clamp is always computed from the **original, immutable `anchorDay`**,
never from the previous cycle's (possibly-clamped) day — this is what fixes
the anchor-drift bug described above. A subscription anchored on the 31st
sees the 31st in every 31-day month, forever, not just once.

### DST handling

Wall-clock-to-UTC-instant conversion is delegated to `date-fns-tz`
(`fromZonedTime`/`formatInTimeZone`), which resolves nonexistent
(spring-forward) and ambiguous (fall-back) local times using the IANA tz
database — we do not hand-roll DST arithmetic. Because the charge time
(09:00 local) is fixed, the *donor-perceived* charge time never moves: it is
always "9am, my time," even though the UTC instant underneath shifts by an
hour when the donor's zone crosses a DST boundary.

**Implementation footgun to be aware of:** date-fns-tz v3's
`toZonedTime`/`fromZonedTime` only behave independently of the *host
process's own timezone* when you interact with them via **strings**
(`formatInTimeZone` to read, a plain `"YYYY-MM-DDTHH:mm:ss"` string with no
`Z`/offset to write). Passing `Date` objects through and reading them back
with `getUTC*()` (or building a "wall clock" via `Date.UTC(...)`) silently
produces answers that depend on `process.env.TZ` / the server's configured
timezone — this bit us during implementation (a sandbox running with
`TZ=Africa/Lagos` produced answers off by exactly that host offset) and is
called out in code comments in both implementations below.

## Where this lives

- `frontend/lib/monthlyGiving.ts` — donor-facing scheduling and display.
  Exports `computeInitialChargeDate`, `computeNextChargeDate`,
  `clampDayToMonth`, `daysInMonth`, and the `CHARGE_LOCAL_HOUR` /
  `DEFAULT_TIME_ZONE` constants.
- `backend/src/utils/recurringSchedule.js` — a 1:1 port of the same
  algorithm and constants, for backend code (a future charge executor, and
  the reconciliation script below) to reuse. **These two files must be kept
  in sync.** Both are covered by property-based tests
  (`frontend/lib/__tests__/monthlyGiving.test.ts` and
  `backend/src/utils/recurringSchedule.test.js`) that include a shared set
  of hardcoded input/output vectors asserted identically on both sides —
  if one side's date math ever drifts from the other's, one of those two
  test suites will fail.
- `frontend/components/MonthlyGivingSetup.tsx` — captures the donor's
  timezone at subscription-creation time and always renders "Next due"
  formatted *in the subscription's stored timezone* (via
  `formatInTimeZone`), not the viewer's ambient device timezone, so the
  displayed date can't drift if the donor (or whoever is looking at the
  admin view) is in a different zone than when the subscription was
  created.
- Legacy subscriptions created before `anchorDay`/`timeZone` existed are
  backfilled on load (`hydrateSubscription` in `monthlyGiving.ts`): they
  default to `timeZone: "UTC"` and derive `anchorDay` from the UTC calendar
  day of their existing `nextDueDate`, which matches the exact behavior
  those records were originally created with.

## Reconciliation

`backend/src/scripts/reconcile-subscriptions.js` compares a subscription's
*expected* charge schedule (computed with the same
`recurringSchedule.js` used above) against its *actual* executed charge
records, and flags:

- `missed_cycle` — an expected charge has no corresponding executed charge.
- `double_charge` — more than one executed charge landed in a single
  cycle's window.
- `date_mismatch` — an executed charge exists for a cycle but outside the
  configured tolerance (default 24h) of the expected date.
- `unexpected_charge` — an executed charge doesn't correspond to any
  expected cycle at all.

Since there is no live DB table for monthly-giving subscriptions or charges
yet (see audit finding #1), the script's core (`computeExpectedChargeDates`,
`detectDrift`, `reconcileAll`) is a **pure, data-source-agnostic function**
you can unit test today and wire up to whichever store eventually holds
this data — it is not wired to a cron/scheduler. `main()` demonstrates it
by reading a JSON export of `{ subscription, charges }` records from disk;
see `backend/src/scripts/reconcile-subscriptions.test.js` for exercised
scenarios (on-time, missed cycle, double charge, date mismatch, unexpected
charge, and a property-based "perfectly on schedule never flags drift"
check).

## Campaign Deadlines & Server-Authoritative Time

Like recurring donation schedules, campaign deadlines must not be left to the mercy of a donor's local clock. Browsers can be skewed by arbitrary user settings or host-machine drift, leading to visual countdowns that contradict the backend's enforcement. 

To prevent this:
1. **Server-Authoritative Enforcement:** The completion status of a campaign is exclusively computed on the backend (e.g., `mapCampaignRow` in `backend/src/routes/projects.js`) by comparing the campaign deadline against the server's `Date.now()`.
2. **Synchronized Client Countdown:** The API responds with `serverNow: Date.now()` injected into the project response. The frontend derives an offset (`project.serverNow - Date.now()`) and applies this offset to every subsequent tick of the countdown. 

This ensures that the countdown shown in the donor's browser perfectly aligns with the server's strict definition of the deadline, and the "Ends in..." display reaches zero at the exact moment the server begins rejecting new donations.
