# Getting Started

Welcome! This guide will walk you step-by-step from zero to making your first testnet donation on the platform — no prior blockchain experience required.

Sections 1–6 cover the donor walkthrough. If you are here to **contribute code**, jump
to [§7 Subproject reference](#7-subproject-reference--build-lint--test), which lists the
build, lint and test command for every subproject in the repo.

---

## 1. Prerequisites

Before you begin, make sure you have the following installed:
| Tool | Version |
|------|---------|
| Node.js | ≥ 18 |
| npm | Latest |
| Docker | Latest (runs PostgreSQL for the backend) |
| Freighter Wallet | Browser extension |

The backend refuses to start without a reachable PostgreSQL instance, so Docker (or a
locally installed PostgreSQL ≥ 14) is required even for the donor walkthrough. Rust and
Go are only needed if you work on the contracts or the scheduler — see
[§7](#7-subproject-reference--build-lint--test) for the per-subproject toolchains.

### ✅ Node.js

- Install Node.js (v18 or higher recommended)
- Verify installation:

```
node -v
npm -v
```

### ✅ Freighter Wallet

Freighter is a browser extension wallet for the Stellar network.

- Install Freighter from: https://freighter.app/
- Create a new wallet (or import an existing one)
- Save your secret key securely (very important!)
- 🔁 Switch Freighter to Testnet

## 2. Clone and Run Locally

- 📥 Clone the Repository

```
git clone <your-repo-url>
cd <your-project-folder>
```

- ⚙️ Run Setup Script

The script lives in `scripts/`, and installs **frontend and backend** dependencies plus
their `.env` files. It does not touch `mobile/`, `extension/` or `scheduler/` — install
those separately if you need them (see [§7](#7-subproject-reference--build-lint--test)).

```
chmod +x scripts/setup-dev.sh
./scripts/setup-dev.sh
```

- 🐘 Start PostgreSQL

The backend runs its migrations and seed data on boot, so the database must be up first.
Without it `npm run dev` exits immediately with `[Startup Error] connect ECONNREFUSED
127.0.0.1:5432`.

```
docker compose up -d postgres
```

Start Backend

```
cd backend
npm install
npm run dev
```

On a successful start you should see `[DB] Migration and seeding complete` followed by
the event-sourcing bootstrap log.

Start Frontend

```
cd frontend
npm install
npm run dev
```

🌐 Open the App

```
http://localhost:3000
```

## 3. Fund Your Testnet Wallet

- Open Freighter Wallet and and ensure you are using Testnet
- Visit [Stellar Friendbot](https://friendbot.stellar.org) with your public key
- Refresh Freighter — your balance should now show test XLM

## 4. Make Your First Donation

- Find a Project
- Open the app in your browser: http://localhost:3000
- Browse projects and select: “Amazon Reforestation”
- Donate 10 XLM
- Approve in Freighter

## 5. Check Your Impact

### After donating:

- Go to: http://localhost:3000/dashboard
- You should see:
    - A donation badge
    - Your CO₂ offset contribution

## 6. View on the Blockchain

### View Transaction

- After donating
- Click the Stellar Expert link from your donation

## 7. Subproject reference — build, lint & test

The repo contains **six** subprojects, each with its own toolchain. There is no root
`package.json` and no workspace manager, so every command below is run from inside the
subproject directory unless stated otherwise.

| Subproject | Path | Stack | Lint | Test | Build | Enforced in CI |
|---|---|---|---|---|---|---|
| Backend | `backend/` | Node.js + Express (CommonJS) | `npm run lint` | `npm test` | — (no build step) | `ci.yml` → lint + test |
| Frontend | `frontend/` | Next.js 14 + TypeScript | `npm run lint` | `npm test`, `npm run test:e2e` | `npm run build` | `ci.yml` → type-check, lint, build, e2e |
| Contracts | `contracts/` | Rust + Soroban (3 crates) | `cargo fmt --check`, `cargo clippy` | `cargo test --workspace` | `cargo build --target wasm32-unknown-unknown --release` | `ci.yml` → check, test, wasm build (**not** fmt/clippy) |
| Mobile | `mobile/` | Expo / React Native + TypeScript | *none configured* | `npm test` | `eas build` (Expo cloud) | `mobile.yml` → install + EAS build only (**tests not run**) |
| Extension | `extension/` | TypeScript + esbuild | *none configured* | `npm test` (Vitest) | `npm run build`, `npm run build:firefox` | `extension.yml` → test + both builds |
| Scheduler | `scheduler/` | Go 1.22 (Kubernetes scheduler plugin) | `gofmt -l .`, `go vet ./...` | `go test ./...` | `go build ./...` | `ci.yml` → format, vet, test, build |

> The issue that prompted this section referred to "seven subprojects". There are six
> code subprojects; `helm/`, `k8s/`, `scripts/` and `docs/` are supporting directories
> with no independent build or test toolchain.

The commands below were run against this repository, and the pass/fail counts quoted are
what they actually produced. Where a command is currently broken, or could not be
exercised without a device or a cloud account, that is stated explicitly rather than
papered over.

### Backend (`backend/`)

Requires Node.js ≥ 18 and a running PostgreSQL (`docker compose up -d postgres` from the
repo root).

```bash
cd backend
npm ci                    # or npm install
npm run lint              # eslint over src/ — currently 34 warnings, 0 errors
npm test                  # jest --runInBand — 10 suites, 78 tests
npm test -- --coverage    # the exact form CI runs
npm run test:local-chain  # real contract -> event indexer -> read-model convergence
npm run dev               # nodemon; needs PostgreSQL
```

There is no build step — `npm start` runs `src/server.js` directly.

`npm run docs` generates TypeDoc HTML into `docs/backend/`. That directory is **not**
gitignored, so running it leaves untracked files in your working tree; delete them before
committing.

Tests do not need PostgreSQL — the suites stub the database layer. Only `npm run dev` and
`npm start` do.

The local-chain test is the exception: it deploys the GreenPay WASM, submits a native
XLM donation, ingests the emitted contract event, and waits for the PostgreSQL project
and donor totals to converge at exact stroop precision. It uses only local services and
does not require a public account or network. From the repository root on an amd64
machine, run the same setup used by CI:

```bash
docker compose up -d postgres
docker run -d --name greenpay-stellar-local -p 8000:8000 \
  stellar/quickstart@sha256:d65f52ac01b3b8ebe4cd4952878433958cea6eb2ee602cb7687127e1df537ddf \
  --local --enable-soroban-rpc

cd contracts
cargo build -p greenpay-contract --target wasm32-unknown-unknown --release

cd ../backend
DATABASE_URL=postgres://postgres:postgres@localhost:5432/greenpay \
GREENPAY_WASM_PATH=../contracts/target/wasm32-unknown-unknown/release/greenpay_contract.wasm \
LOCAL_STELLAR_HORIZON_URL=http://127.0.0.1:8000 \
LOCAL_STELLAR_RPC_URL=http://127.0.0.1:8000/soroban/rpc \
npm run test:local-chain

docker rm -f greenpay-stellar-local
```

The Quickstart digest is the protocol 21 build from source revision `ae7fdb0`, matching
the repository's Soroban SDK 21 contracts. The test polls chain finality and each
projection boundary with a deadline; it does not use fixed sleeps for convergence.

### Frontend (`frontend/`)

```bash
cd frontend
npm ci
npm run type-check        # tsc --noEmit
npm run lint              # next lint — currently 5 warnings, 0 errors
npm test                  # jest — 4 suites, 28 tests
npm run build             # next build
npm run test:e2e          # playwright — 23 tests
```

`npm run build` and `npm run test:e2e` need the public env vars set. Copy
`frontend/.env.example` to `frontend/.env.local` (the setup script does this for you), or
export them inline as CI does:

```bash
NEXT_PUBLIC_STELLAR_NETWORK=testnet \
NEXT_PUBLIC_HORIZON_URL=https://horizon-testnet.stellar.org \
NEXT_PUBLIC_API_URL=http://localhost:4000 \
npm run build
```

The e2e suite is self-contained: `playwright.config.ts` starts a stub backend on port
4000 and `next start` on port 3000 for you. It does require a production build first
(`npm run build`) and the Playwright browser:

```bash
npx playwright install --with-deps chromium
```

### Contracts (`contracts/`)

Requires Rust (the workspace pins `stable` via `rust-toolchain.toml`) and the wasm
target:

```bash
rustup target add wasm32-unknown-unknown
```

```bash
cd contracts
cargo fmt --all -- --check                                    # clean
cargo clippy --workspace --all-targets --all-features -- -D warnings   # clean
cargo check --workspace
cargo test --workspace                                        # 95 tests across 3 crates
cargo build --workspace --target wasm32-unknown-unknown --release
```

The release build emits three artifacts into
`contracts/target/wasm32-unknown-unknown/release/`: `greenpay_contract.wasm`,
`escrow_contract.wasm` and `dao_governance_contract.wasm`.

The same steps are wrapped by the root `Makefile.contracts`. Note the non-default
filename — you must pass `-f`:

```bash
make -f Makefile.contracts help     # list all targets
make -f Makefile.contracts lint     # fmt --check + clippy -D warnings
make -f Makefile.contracts test
make -f Makefile.contracts build
```

`make -f Makefile.contracts audit` requires `cargo-audit`
(`cargo install cargo-audit`), and the deployment targets require the Stellar/Soroban
CLI — neither is needed for ordinary contract work.

### Mobile (`mobile/`)

```bash
cd mobile
npm ci
npm test                  # jest-expo
npx expo start            # dev server; needs a simulator or the Expo Go app
```

**`npm test` does not currently pass.** 7 tests across 2 suites
(`__tests__/HomeScreen.test.tsx`, `__tests__/offlineSupport.test.tsx`) fail because the
test fixtures no longer match what the screens render — the mocked API responses supply a
single project object where the screens now expect a list, so nothing renders and the
text assertions miss. The other 16 suites (161 tests) pass. This is pre-existing drift,
not something you broke; no mobile workflow runs these tests, which is how it went
unnoticed.

There is no lint script, no ESLint config, and **no `tsconfig.json` or `typescript`
dependency** — despite 32 `.ts`/`.tsx` files. `tsc --noEmit` is therefore not available
here.

Production builds go through Expo Application Services (`eas build`), which needs an
Expo account and an `EXPO_TOKEN`; you cannot build the app purely locally. `npx expo
start` and `eas build` both need a device, simulator or Expo account, so neither can be
smoke-tested from a plain terminal — only `npm ci` and `npm test` were verified here.

### Extension (`extension/`)

```bash
cd extension
npm ci
npm test                  # vitest run — 3 files, 10 tests
npm run build             # esbuild → dist/       (Chrome, manifest.json)
npm run build:firefox     # esbuild → dist-firefox/ (manifest.firefox.json)
npm run dev               # build --watch
npx tsc --noEmit          # type-check; not wired to a script and not run in CI
```

There is no lint script and no ESLint config. `tsconfig.json` exists and is strict, so
`npx tsc --noEmit` works and passes — it is just not part of `npm test` or the workflow.

To load the unpacked extension: run `npm run build`, then in Chrome open
`chrome://extensions`, enable Developer mode, and "Load unpacked" pointing at the
`extension/` directory.

### Scheduler (`scheduler/`)

Requires Go ≥ 1.22.

> **Currently broken.** `scheduler/go.sum` is missing from the repository, so every Go
> command fails before compiling anything:
>
> ```
> pkg/hardware/node_info.go:6:2: missing go.sum entry for module providing package
> k8s.io/api/core/v1 (imported by github.com/greenpay/scheduler/pkg/hardware); to add:
>         go get github.com/greenpay/scheduler/pkg/hardware
> ```
>
> This affects `go build ./...`, `go vet ./...` and `go test ./...` alike, and it also
> breaks `scheduler/Dockerfile`, which does `COPY go.mod go.sum ./`. Regenerating it
> with `go mod tidy` requires network access to `sigs.k8s.io/scheduler-plugins`.

Once a `go.sum` exists, the intended sequence is:

```bash
cd scheduler
go mod download
gofmt -l .                # currently lists 3 unformatted files (see below)
go vet ./...
go test ./...
go build ./...
```

`gofmt -l .` reports `pkg/hardware/labels.go`, `pkg/hardware/node_info_test.go` and
`pkg/plugins/score.go` as unformatted; `gofmt -w .` fixes them. There is no `golangci`
config and no CI workflow covering this directory at all, which is why the missing
`go.sum` and the formatting drift both went unnoticed.

## 8. Known tooling divergence

These are deliberate notes about the *current* state, not aspirations. They exist so you
are not surprised when one subproject's conventions do not apply to the next.

- **Lint coverage is partial.** Only `backend/` and `frontend/` have an ESLint config,
  both in the legacy `.eslintrc.json` format on ESLint 8 (not flat config). `mobile/`,
  `extension/` and `scheduler/` have no linter configured.
- **The two ESLint configs enforce different things.** `backend/.eslintrc.json` extends
  `eslint:recommended` plus `plugin:security/recommended-legacy` and adds hard style
  rules (2-space indent, double quotes, semicolons, unix line endings).
  `frontend/.eslintrc.json` extends only `next/core-web-vitals` and enforces no style
  rules at all. Do not assume backend style rules apply to frontend code.
- **Prettier is not used anywhere.** There is no Prettier config or dependency in any
  subproject; formatting is enforced only by ESLint (backend), `cargo fmt` (contracts)
  and `gofmt` (scheduler, uncommitted).
- **`cargo fmt` and `cargo clippy` are not enforced by CI.** The `contracts` job in
  `ci.yml` runs `cargo check`, `cargo test` and the wasm build only. The strict
  `-D warnings` clippy gate exists solely in `Makefile.contracts lint`, which nothing
  runs automatically. Both currently pass — run `make -f Makefile.contracts lint` before
  pushing contract changes.
- **Mobile tests are never run by CI.** `mobile.yml` installs dependencies and triggers
  an EAS preview build; it never invokes `npm test`. Run it locally.
- **The scheduler has no CI workflow.** Nothing in `.github/workflows/` references
  `scheduler/`.
- **TypeScript coverage is uneven.** `frontend/` type-checks in CI, `extension/` has a
  strict `tsconfig.json` that nothing runs, and `mobile/` has no TypeScript setup at all.

## Troubleshooting

### Problem: App says wallet not detected

- Ensure Freighter extension is installed
- Refresh the page
- Make sure it’s enabled in your browser

### Problem: Wallet shows 0 XLM

- Ensure your Freighter wallet is set to in Testnet
- Use Friendbot again:
- https://friendbot.stellar.org/?addr=YOUR_PUBLIC_ADDRESS
- Refresh the wallet

### Problem: Donation fails or is rejected

- Not enough balance → fund wallet again
- Wrong network → switch Freighter to Testnet
- User rejected → retry and approve in Freighter
- Backend not running → ensure backend server is active

### Problem: Backend exits straight after starting

If the log shows `[Startup Error] connect ECONNREFUSED 127.0.0.1:5432`, PostgreSQL is not
running. Start it and retry:

```
docker compose up -d postgres
```

### Problem: Page doesn’t load or API fails

- Confirm both frontend and backend are running
- Check terminal logs for errors
- Restart both servers

Start Backend

```
cd backend
npm install
npm run dev
```

Start Frontend

```
cd frontend
npm install
npm run dev
```
