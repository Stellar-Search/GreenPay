# Recurring / monthly donations (mobile)

## Why there is no auto-signing

GreenPay mobile **never persists Stellar secret keys**. Offline donation intents,
wallet connect, and biometric gates all assume the donor re-enters `S...` only
for the moment of signing. Auto-debiting a monthly gift would require either:

1. storing a secret or signing key on device, or
2. holding custodial keys server-side,

both of which contradict that security posture. Recurring donations are therefore
a **schedule + reminder** system, not an autopay engine.

## How a cycle runs

1. **Create** — From a project or donate screen the donor taps
   “Set up monthly giving”. `createRecurringDonation` stores the schedule in
   AsyncStorage and schedules a **local** Expo notification for `nextDueDate`
   (one month out by default).
2. **Trigger** — When `nextDueDate` arrives, the notification fires with body
   “your monthly donation is due — tap to sign” and data
   `greenpay://recurring/<id>`. Tapping it deep-links into the donate screen
   with amount and `recurringId` prefilled.
3. **Sign** — The donor enters their secret key and completes a normal donation.
4. **Advance** — On successful Horizon + backend confirmation,
   `completeRecurringCycle` decrements `remainingMonths`, advances
   `nextDueDate` by one calendar month (anchor-day clamping), reschedules the
   next reminder, or marks the entry `completed` when remaining hits 0.

Cancel clears the scheduled notification and sets status to `cancelled`.

## Deep link

`greenpay://recurring/<recurringId>` is an allowlisted segment in
`parseGreenPayDeepLink`. The id uses the same charset as project ids
(`[a-zA-Z0-9_-]{1,64}`).
