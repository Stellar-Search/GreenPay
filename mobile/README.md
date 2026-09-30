# Stellar GreenPay Mobile App

React Native + Expo mobile app for Stellar GreenPay climate donation platform.

## Features

- Browse climate projects
- Donate using mobile Stellar wallet (Freighter deep links)
- View donation history and impact
- Real-time donation feed
- Push notifications for donation receipts

## Setup

1. Install dependencies:
```bash
cd mobile
npm install
```

2. Configure environment:
```bash
cp .env.example .env
# Edit .env with your API URL and Stellar network settings
```

3. Run on device/simulator:
```bash
# iOS
npm run ios

# Android
npm run android

# Expo Go (for quick testing)
npm start
```

## Expo Go Preview

Preview builds are generated automatically on every push to `main` via EAS Build.

[![Open in Expo Go](https://img.shields.io/badge/Expo%20Go-Scan%20QR-000?logo=expo)](https://expo.dev/@OWNER/stellar-greenpay)

> Replace `OWNER` with your Expo account username. Add `EXPO_TOKEN` as a GitHub Actions repository secret (Settings → Secrets and variables → Actions) before the first build.

- **Android**: APK (direct install, no Play Store needed)
- **iOS**: Simulator build (`.app` bundle, not a signed IPA)

## Shared API Client

The mobile app shares the API client logic with the web frontend. The API functions are located in `lib/api.ts` and are imported from the shared package.

## Wallet Integration

The app integrates with mobile Stellar wallets via deep links:
- Freighter Mobile: `freighter://tx?xdr=...`
- Other wallets can be added via similar deep link schemes

## Architecture

- **expo-router**: File-based routing
- **app/**: Screen components
- **lib/**: Shared utilities (API, Stellar SDK helpers)
- **components/**: Reusable UI components
- **styles/**: Theme and styling (matches web green theme)

## Environment Variables

See `.env.example` for required variables:
- `EXPO_PUBLIC_API_URL`: Backend API URL
- `EXPO_PUBLIC_STELLAR_NETWORK`: testnet or mainnet
- `EXPO_PUBLIC_HORIZON_URL`: Stellar Horizon URL

## Offline & Resilience

### Donation Queue

Donations can be initiated while the device is offline. The intent (project,
amount, donor public address, optional message) is persisted to
`AsyncStorage` via `utils/donationQueue.ts`. **Secret keys are never stored.**
When connectivity is restored, `hooks/useDonationSync.ts` runs a preflight
check (balance, project status, duplicate detection) and marks the entry
`ready` for the user to complete on the donate screen.

### Horizon-accepted / Backend-failed Recovery (issue #359)

If a payment is accepted by the Stellar network but the backend confirmation
POST fails afterward — whether the donation originated from the offline queue
*or* from a plain online attempt — the transaction hash is **always persisted**
in a queue entry before the user can navigate away. This guarantees:

- **No resubmission**: once a `horizonTransactionHash` is recorded on an
  entry, no code path will call `server.submitTransaction()` for it again.
- **Automatic retry on reconnect**: `useDonationSync` detects entries with a
  recorded hash on the next reconnect and retries only the backend
  confirmation POST, never the Horizon submission.
- **On-screen retry**: the donate screen's *Confirm with server* button
  becomes available immediately after the failure so users can retry without
  leaving the screen.
- **Single recording**: the donation is recorded in the backend exactly once
  regardless of how many retry attempts are needed.

## Testing

```bash
cd mobile
npm test                                              # all tests
npm test -- --testPathPattern DonateScreen            # donate screen + issue #359 tests
npm test -- --testPathPattern donationSync            # reconnect sync engine tests
```

Key test files:

| File | What it covers |
|---|---|
| `__tests__/DonateScreen.test.tsx` | Biometric gate, offline queueing, queue completion, issue #359 recovery |
| `__tests__/donationSync.test.tsx` | Reconnect preflight: conflicts, balance checks, rate-limit backoff, deduplication |
| `__tests__/donationQueue.test.ts` | Queue CRUD and serialisation |

## Versioning & Over-The-Air Updates

The app uses the "appVersion" policy for the "runtimeVersion" to handle over-the-air (OTA) updates securely. This means any EAS Update will only be applied to builds matching the exact "version" string in `app.json`. 

For Store builds, we bump the `version` and respectively `buildNumber` (iOS) and `versionCode` (Android) in `app.json`, so that they map to a distinct runtime version. Updates are purely for Javascript/asset changes without native code alterations.
