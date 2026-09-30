# OTA Release Runbook — GreenPay Mobile

This runbook covers the complete lifecycle of an over-the-air (OTA) JavaScript
bundle update: pre-publish checks, publishing, staged rollout, crash-rate
monitoring, aborting a rollout, rolling back, and post-incident review.

**Roles**

| Decision point | Owner |
|---|---|
| Publish & advance rollout | Release engineer |
| Halt rollout (threshold exceeded) | On-call engineer |
| Roll back | On-call engineer |
| File post-incident report | On-call engineer |
| Policy-compliance review | Release engineer |

---

## 1. Pre-publish Checklist

Complete every item before running `eas update`.

- [ ] All CI checks on the branch are green (test, audit, validate-app-json).
- [ ] `app.json` `runtimeVersion.policy` is `"fingerprintExperimental"`.
- [ ] **No new native module** has been added, removed, or upgraded. OTA bundles
  may not introduce new native dependencies (see §7 — Store Policy).
- [ ] **No new entitlement or permission** string has been added (iOS entitlements,
  Android `uses-permission`). These require a store submission.
- [ ] `EXPO_PUBLIC_SENTRY_DSN` and `SENTRY_AUTH_TOKEN` are configured as EAS
  secrets (`eas secret:list`).
- [ ] Source maps will be uploaded automatically by CI after the EAS build. If
  publishing manually, upload source maps manually (see §2).
- [ ] The Sentry project `greenpay-mobile` is reachable and the DSN is valid.
- [ ] Record the current `production` channel bundle ID before publishing, in
  case a rollback is needed.

```sh
# Capture the current production bundle ID (save this before publishing)
eas update:list --branch production --json | jq '.[0].id'
```

---

## 2. Publishing an OTA Update

```sh
# Publish to the production channel (starts at 5% — see §3)
eas update \
  --branch production \
  --message "describe what changed" \
  --non-interactive

# Preview channel (safe for testing rollout procedure)
eas update \
  --branch preview \
  --message "describe what changed" \
  --non-interactive
```

If publishing outside of CI, upload source maps manually so crash reports are
symbolicated:

```sh
UPDATE_ID=$(eas update:list --branch production --json | jq -r '.[0].id')
npx @sentry/cli@2 releases files "$UPDATE_ID" \
  upload-sourcemaps ./dist \
  --org greenpay \
  --project greenpay-mobile
```

---

## 3. Advancing Rollout Stages

Rollout stages: **5% → 20% → 50% → 100%**

Before advancing, verify the crash rate for the current cohort is below the
abort threshold (see §4). The minimum observation window before advancing is
**1 hour**. Do not advance if fewer than 20 sessions have been recorded.

```sh
# Check current rollout percentage
eas channel:view production

# Advance to 20%
eas channel:edit production --rollout-percent 20

# Advance to 50%
eas channel:edit production --rollout-percent 50

# Full rollout
eas channel:edit production --rollout-percent 100
```

---

## 4. Monitoring Crash Rate

**Abort Threshold: > 1% crash rate over any rolling 15-minute window with ≥ 20 sessions**

Query crash rate in Sentry:

1. Open Sentry → Projects → `greenpay-mobile`
2. Go to **Issues** → filter by `release:<UPDATE_ID>`
3. Go to **Performance** → **Crash Rate** — set window to 15 minutes
4. If crash rate exceeds 1 % **and** session count ≥ 20, halt immediately (§5)

Sentry CLI equivalent:

```sh
# List recent issues for this update
npx @sentry/cli@2 releases info "$UPDATE_ID"
```

Set a Sentry alert rule: `crash_rate > 0.01 AND session_count >= 20` → notify
on-call channel. The alert is mandatory, not advisory.

---

## 5. Aborting a Rollout

When the abort threshold is exceeded, **halt immediately**. Do not wait for
confirmation.

```sh
# Stop further rollout — freeze at current percentage
eas channel:edit production --rollout-percent 0

# Or roll back immediately to the previous bundle (see §6)
```

Notify the on-call engineer. Document the crash rate, session count, time of
halt, and the UPDATE_ID in the incident channel.

Rollout does **not** resume automatically. An explicit advance command (§3) is
required after the incident is resolved.

---

## 6. Performing a Rollback

A rollback re-promotes a previously published bundle to 100% of devices.
Devices receive the rolled-back bundle on their next update check (next
foreground with network available).

Target completion: **within 5 minutes** of the rollback decision.

```sh
# List recent bundles to find the last known-good bundle ID
eas update:list --branch production --json | jq '.[] | {id, message, createdAt}'

# Roll back to a specific bundle (replace PREVIOUS_UPDATE_ID)
eas channel:rollback production --update-id PREVIOUS_UPDATE_ID

# Verify the channel now points to the previous bundle
eas channel:view production
```

Expected device behaviour: on next app foreground, `expo-updates` fetches and
applies the rolled-back bundle. The app restarts with the previous bundle active.

---

## 6.1 Rollback Drill Procedure (Preview Channel)

Run this drill against the `preview` channel to rehearse before relying on
rollback in production. Repeat **quarterly**.

1. Publish a test update to `preview`:
   ```sh
   eas update --branch preview --message "drill: test bundle v2"
   ```
2. Note the bundle ID of the new update (v2) and the previous bundle (v1).
3. Roll back to v1:
   ```sh
   eas channel:rollback preview --update-id <v1-bundle-id>
   ```
4. Verify the preview channel shows v1 as the active bundle:
   ```sh
   eas channel:view preview
   ```
5. Install the preview build on a test device and confirm the app reflects v1.
6. Record completion below.

**Drill completion log** (update after each drill):

| Date | Performed by | Outcome |
|---|---|---|
| _not yet performed_ | — | — |

Recurrence: at least once per quarter. The next drill is due within 90 days of
the last entry above.

---

## 7. Store Policy Compliance

Apple App Store and Google Play permit OTA JavaScript bundle updates within the
following constraints. Violating these constraints risks app removal.

**Permitted via OTA:**
- Bug fixes and behavioural changes implemented entirely in JavaScript
- UI/UX changes that do not alter the core purpose of the app
- Content updates

**NOT permitted via OTA (requires a store submission):**
- Adding, removing, or upgrading a native module (will also produce a new
  `fingerprintExperimental` runtime version, so EAS will refuse delivery)
- New iOS entitlements or Info.plist keys
- New Android `uses-permission` entries
- Changes to the app's core functionality or purpose that circumvent app review

The pre-publish checklist (§1) enforces these constraints. The CI
`validate-app-json` step verifies the `fingerprintExperimental` policy on every
push to `main`.

**Policy review:** update this section whenever Apple or Google publishes a
change to their OTA update policies.

| Review date | Reviewed by | Notes |
|---|---|---|
| _not yet reviewed_ | — | — |

---

## 8. Post-Incident Review

After any rollback or aborted rollout, file a post-incident report within 24 hours.

**Required content:**

1. Timeline of events (publish time, first alert, halt/rollback time)
2. UPDATE_ID of the affected bundle
3. Crash rate at time of halt (include Sentry screenshot)
4. Root cause of the defect
5. Fix or mitigation applied
6. Whether the rollback drill had been performed recently (date of last drill)
7. Action items to prevent recurrence

Retain incident reports for at least **90 days** (matches rollout log retention
in Sentry).

---

## Quick-Reference: Key Commands

| Action | Command |
|---|---|
| Publish to production | `eas update --branch production --message "..."` |
| Publish to preview | `eas update --branch preview --message "..."` |
| Check current rollout | `eas channel:view production` |
| Advance to 20% | `eas channel:edit production --rollout-percent 20` |
| Advance to 50% | `eas channel:edit production --rollout-percent 50` |
| Full rollout | `eas channel:edit production --rollout-percent 100` |
| Halt rollout | `eas channel:edit production --rollout-percent 0` |
| Roll back | `eas channel:rollback production --update-id <ID>` |
| List bundles | `eas update:list --branch production --json` |
| Upload source maps | `npx @sentry/cli@2 releases files <ID> upload-sourcemaps ./dist` |
