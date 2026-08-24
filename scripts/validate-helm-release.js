#!/usr/bin/env node
/**
 * scripts/validate-helm-release.js
 *
 * Pre-deploy guard for the GreenPay Helm chart.
 *
 * A GreenPay release is a network mismatch away from a fund-losing bug: a
 * `helm upgrade` that renders `STELLAR_NETWORK: mainnet` alongside a leftover
 * testnet Horizon URL, a testnet contract id, or an inline development
 * password will start, pass its health check, and quietly transact against the
 * wrong chain.
 *
 * This script renders the merged values with `helm template` and asserts the
 * invariants on the *rendered* output rather than on any single values file.
 * That distinction matters: linting `values-mainnet.yaml` alone cannot see a
 * bad merge, an override from a third `-f` file, or a stray `--set`. What the
 * cluster will actually receive is what gets checked.
 *
 * Usage:
 *   # validate the committed testnet defaults
 *   node scripts/validate-helm-release.js --expect-network testnet
 *
 *   # validate a mainnet release exactly as it will be deployed
 *   node scripts/validate-helm-release.js \
 *     -f helm/greenpay/values.yaml -f helm/greenpay/values-mainnet.yaml \
 *     --set config.contractId=C... --set ingress.host=app.example.org \
 *     --expect-network mainnet
 *
 *   # validate what is already running
 *   helm get manifest greenpay -n greenpay | node scripts/validate-helm-release.js --manifest -
 *
 * Options:
 *   --chart <dir>            chart directory (default: helm/greenpay)
 *   -f, --values <file>      values file, repeatable (default: <chart>/values.yaml)
 *   --set <key=value>        passed through to helm, repeatable
 *   --release <name>         release name for rendering (default: greenpay)
 *   --expect-network <net>   fail unless the render targets this network
 *   --manifest <file|->      validate a pre-rendered manifest instead of templating
 *
 * Exit code 0 = safe to deploy, 1 = do not deploy.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const HELM_BIN = process.env.HELM_BIN || "helm";

// Passwords that must never reach mainnet, whatever else is true of them.
const DEFAULT_PASSWORDS = new Set([
  "changeme",
  "changeit",
  "password",
  "postgres",
  "admin",
  "secret",
  "root",
  "test",
  "greenpay",
]);
const MIN_MAINNET_PASSWORD_LENGTH = 12;

// Endpoints that only exist on pubnet. Seeing one while the network says
// testnet is the same class of mismatch, in the other direction.
const PUBNET_URL_HOSTS = [
  "horizon.stellar.org",
  "soroban.stellar.org",
  "mainnet.sorobanrpc.com",
  "rpc.stellar.org",
];

// Substrings that mark a URL as non-pubnet.
const NON_PUBNET_URL_MARKERS = /testnet|futurenet|localhost|127\.0\.0\.1|\.local\b/i;

// Reserved / placeholder TLDs (RFC 2606 + RFC 6761) plus the .env template
// domain. A mainnet release pointed at one of these is not configured.
const PLACEHOLDER_TLDS = new Set(["example", "invalid", "test", "local", "localhost"]);
const PLACEHOLDER_DOMAINS = [/yourdomain\.com/i, /your-production/i, /^greenpay\.local$/i];

const STELLAR_CONTRACT_ID = /^C[A-Z2-7]{55}$/;
const STELLAR_ACCOUNT_ID = /^G[A-Z2-7]{55}$/;

// ── Rendering ────────────────────────────────────────────────────────────────

function renderWithHelm({ chart, valuesFiles, sets, release }) {
  const args = ["template", release, chart];
  for (const f of valuesFiles) args.push("--values", f);
  for (const s of sets) args.push("--set", s);

  const result = spawnSync(HELM_BIN, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

  if (result.error && result.error.code === "ENOENT") {
    throw new Error(
      `'${HELM_BIN}' not found on PATH. Install Helm 3 (https://helm.sh/docs/intro/install/) ` +
        `or set HELM_BIN to its location.`
    );
  }
  if (result.status !== 0) {
    throw new Error(`helm template failed (exit ${result.status}):\n${result.stderr.trim()}`);
  }
  return result.stdout;
}

// ── Manifest reading ─────────────────────────────────────────────────────────
//
// The chart emits flat `KEY: value` maps under data/stringData, so a targeted
// reader is enough and keeps this script dependency-free. It is deliberately
// strict: if the shape it expects is not there, it reports that as a failure
// rather than validating nothing and reporting success.

function splitDocuments(manifest) {
  return manifest
    .split(/^---\s*$/m)
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
}

function docKind(doc) {
  const m = doc.match(/^kind:\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}

function docName(doc) {
  const m = doc.match(/^metadata:\s*$\n(?:\s{2}.*\n)*?\s{2}name:\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}

function unquote(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/** Read the flat key/value map under `data:` or `stringData:` in one document. */
function readFlatMap(doc, blockKey) {
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => l === `${blockKey}:`);
  if (start === -1) return null;

  const out = {};
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) break; // dedented back to a top-level key
    const m = line.match(/^\s{2}([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (m) out[m[1]] = unquote(m[2]);
  }
  return out;
}

function readManifest(manifest) {
  const docs = splitDocuments(manifest);
  const found = { configMap: null, secret: null, ingressHosts: [], ingressTLS: false, ingressFound: false };

  for (const doc of docs) {
    const kind = docKind(doc);
    const name = docName(doc);

    if (kind === "ConfigMap" && name === "greenpay-config") {
      found.configMap = readFlatMap(doc, "data");
    } else if (kind === "Secret" && name === "greenpay-secrets") {
      found.secret = readFlatMap(doc, "stringData");
    } else if (kind === "Ingress") {
      found.ingressFound = true;
      // Horizontal whitespace only: \s would let an empty host swallow the
      // newline and capture the next line's content instead.
      for (const m of doc.matchAll(/^[ \t]+-[ \t]+host:[ \t]*(\S*)[ \t]*$/gm)) found.ingressHosts.push(unquote(m[1]));
      if (/^\s{2}tls:\s*$/m.test(doc)) found.ingressTLS = true;
    }
  }
  return found;
}

// ── Invariants ───────────────────────────────────────────────────────────────

function normalizeNetwork(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "public" || v === "pubnet" || v === "mainnet") return "mainnet";
  return v;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isPlaceholderHost(host) {
  if (!host) return true;
  const h = host.trim().toLowerCase();
  if (h === "" || h === "localhost") return true;
  if (PLACEHOLDER_DOMAINS.some((re) => re.test(h))) return true;
  const tld = h.split(".").pop();
  return PLACEHOLDER_TLDS.has(tld);
}

function isDefaultPassword(pw) {
  return DEFAULT_PASSWORDS.has(String(pw || "").trim().toLowerCase());
}

/**
 * Runs every invariant against a rendered manifest.
 * Returns { network, errors: string[] }.
 */
function validateManifest(manifest, { expectNetwork = null } = {}) {
  const errors = [];
  const { configMap, secret, ingressHosts, ingressTLS, ingressFound } = readManifest(manifest);

  if (!configMap) {
    errors.push(
      "rendered manifest has no ConfigMap/greenpay-config with a data: block — the guard " +
        "cannot verify this release (did the chart templates get renamed?)"
    );
    return { network: null, errors };
  }

  const get = (k) => (configMap[k] === undefined ? "" : configMap[k]);
  const network = normalizeNetwork(get("STELLAR_NETWORK"));
  const publicNetwork = normalizeNetwork(get("NEXT_PUBLIC_STELLAR_NETWORK"));

  if (network !== "mainnet" && network !== "testnet") {
    errors.push(`STELLAR_NETWORK is ${JSON.stringify(get("STELLAR_NETWORK"))}; expected "mainnet" or "testnet"`);
  }

  if (expectNetwork) {
    const want = normalizeNetwork(expectNetwork);
    if (network !== want) {
      errors.push(
        `release renders STELLAR_NETWORK=${network || "(unset)"} but the deploy expects ${want} — ` +
          "the values files in use are for the wrong environment"
      );
    }
  }

  // Backend and frontend must agree; they are read by different processes.
  if (network !== publicNetwork) {
    errors.push(
      `backend/frontend network mismatch: STELLAR_NETWORK=${network || "(unset)"} but ` +
        `NEXT_PUBLIC_STELLAR_NETWORK=${publicNetwork || "(unset)"}`
    );
  }
  if (get("HORIZON_URL") !== get("NEXT_PUBLIC_HORIZON_URL")) {
    errors.push(
      `backend/frontend Horizon mismatch: HORIZON_URL=${get("HORIZON_URL") || "(unset)"} but ` +
        `NEXT_PUBLIC_HORIZON_URL=${get("NEXT_PUBLIC_HORIZON_URL") || "(unset)"}`
    );
  }
  if (get("SOROBAN_RPC_URL") !== get("NEXT_PUBLIC_SOROBAN_RPC_URL")) {
    errors.push(
      `backend/frontend Soroban RPC mismatch: SOROBAN_RPC_URL=${get("SOROBAN_RPC_URL") || "(unset)"} but ` +
        `NEXT_PUBLIC_SOROBAN_RPC_URL=${get("NEXT_PUBLIC_SOROBAN_RPC_URL") || "(unset)"}`
    );
  }
  if (get("CONTRACT_ID") !== get("NEXT_PUBLIC_CONTRACT_ID")) {
    errors.push(
      `backend/frontend contract mismatch: CONTRACT_ID=${get("CONTRACT_ID") || "(unset)"} but ` +
        `NEXT_PUBLIC_CONTRACT_ID=${get("NEXT_PUBLIC_CONTRACT_ID") || "(unset)"}`
    );
  }

  // backend/src/services/stellar.js falls back to the testnet RPC when this is
  // unset, so an absent value is a silent testnet downgrade, not a no-op.
  if (get("SOROBAN_RPC_URL") === "") {
    errors.push(
      "SOROBAN_RPC_URL is not rendered — backend/src/services/stellar.js would silently " +
        "fall back to the testnet Soroban RPC"
    );
  }

  const horizon = get("HORIZON_URL");
  const soroban = get("SOROBAN_RPC_URL");

  if (network === "mainnet") {
    for (const [label, url] of [["HORIZON_URL", horizon], ["SOROBAN_RPC_URL", soroban]]) {
      if (url && NON_PUBNET_URL_MARKERS.test(url)) {
        errors.push(`stellarNetwork is mainnet but ${label}=${url} is not a pubnet endpoint`);
      }
    }

    const contractId = get("CONTRACT_ID");
    if (contractId === "") {
      errors.push("stellarNetwork is mainnet but CONTRACT_ID is empty — set config.contractId to the deployed mainnet contract");
    } else if (!STELLAR_CONTRACT_ID.test(contractId)) {
      errors.push(`stellarNetwork is mainnet but CONTRACT_ID=${contractId} is not a well-formed Stellar contract id`);
    }

    const usdcIssuer = get("NEXT_PUBLIC_USDC_ISSUER");
    if (usdcIssuer === "") {
      errors.push("stellarNetwork is mainnet but NEXT_PUBLIC_USDC_ISSUER is empty");
    } else if (!STELLAR_ACCOUNT_ID.test(usdcIssuer)) {
      errors.push(`stellarNetwork is mainnet but NEXT_PUBLIC_USDC_ISSUER=${usdcIssuer} is not a well-formed Stellar account id`);
    }

    // Credentials. When secrets.provider is external (or existingSecret is
    // set) the chart renders no inline Secret — nothing to check here.
    if (secret) {
      const pw = secret.POSTGRES_PASSWORD || "";
      if (isDefaultPassword(pw)) {
        errors.push(`stellarNetwork is mainnet but POSTGRES_PASSWORD is the default value ${JSON.stringify(pw)}`);
      } else if (pw.length < MIN_MAINNET_PASSWORD_LENGTH) {
        errors.push(
          `stellarNetwork is mainnet but POSTGRES_PASSWORD is ${pw.length} characters ` +
            `(minimum ${MIN_MAINNET_PASSWORD_LENGTH})`
        );
      }

      const dbUrl = secret.DATABASE_URL || "";
      const embedded = dbUrl.match(/^postgres(?:ql)?:\/\/[^:]+:([^@]*)@/);
      if (embedded && isDefaultPassword(decodeURIComponent(embedded[1]))) {
        errors.push("stellarNetwork is mainnet but DATABASE_URL embeds a default password");
      }

      if (!secret.ADMIN_API_KEY) {
        errors.push("stellarNetwork is mainnet but ADMIN_API_KEY is empty");
      } else if (isDefaultPassword(secret.ADMIN_API_KEY)) {
        errors.push("stellarNetwork is mainnet but ADMIN_API_KEY is a default value");
      }
    }

    // Public surface.
    if (!ingressFound) {
      errors.push("rendered manifest has no Ingress — the guard cannot verify the public host of this release");
    }
    for (const host of ingressHosts) {
      if (isPlaceholderHost(host)) {
        errors.push(
          `stellarNetwork is mainnet but ingress host is ${host === "" ? "(empty)" : host} — ` +
            "set ingress.host to the real production hostname"
        );
      }
    }
    if (ingressFound && !ingressTLS) {
      errors.push("stellarNetwork is mainnet but the Ingress has no tls block — set ingress.tls.enabled=true");
    }
    if (!get("ALLOWED_ORIGINS").startsWith("https://")) {
      errors.push(`stellarNetwork is mainnet but ALLOWED_ORIGINS=${get("ALLOWED_ORIGINS") || "(unset)"} is not https`);
    }

    const emailFrom = get("EMAIL_FROM");
    const emailDomain = (emailFrom.match(/@([A-Za-z0-9.-]+)/) || [])[1];
    if (emailFrom === "") {
      errors.push("stellarNetwork is mainnet but EMAIL_FROM is empty");
    } else if (isPlaceholderHost(emailDomain)) {
      errors.push(`stellarNetwork is mainnet but EMAIL_FROM=${emailFrom} uses a placeholder sender domain`);
    }
  }

  if (network === "testnet") {
    for (const [label, url] of [["HORIZON_URL", horizon], ["SOROBAN_RPC_URL", soroban]]) {
      const h = hostOf(url);
      if (h && PUBNET_URL_HOSTS.includes(h)) {
        errors.push(`stellarNetwork is testnet but ${label}=${url} is a pubnet endpoint`);
      }
    }
    const contractId = get("CONTRACT_ID");
    if (contractId !== "" && !STELLAR_CONTRACT_ID.test(contractId)) {
      errors.push(`CONTRACT_ID=${contractId} is not a well-formed Stellar contract id`);
    }
  }

  return { network, errors };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const USAGE = `Usage:
  node scripts/validate-helm-release.js [options]

Options:
  --chart <dir>            chart directory (default: helm/greenpay)
  -f, --values <file>      values file, repeatable (default: <chart>/values.yaml)
  --set <key=value>        passed through to helm, repeatable
  --release <name>         release name used for rendering (default: greenpay)
  --expect-network <net>   fail unless the render targets this network
  --manifest <file|->      validate a pre-rendered manifest instead of templating
  -h, --help               show this help

Exit code 0 = safe to deploy, 1 = do not deploy.`;

function parseArgs(argv) {
  const opts = {
    chart: path.join(ROOT, "helm", "greenpay"),
    valuesFiles: [],
    sets: [],
    release: "greenpay",
    expectNetwork: null,
    manifest: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    switch (a) {
      case "--chart": opts.chart = next(); break;
      case "-f":
      case "--values": opts.valuesFiles.push(next()); break;
      case "--set": opts.sets.push(next()); break;
      case "--release": opts.release = next(); break;
      case "--expect-network": opts.expectNetwork = next(); break;
      case "--manifest": opts.manifest = next(); break;
      case "-h":
      case "--help": opts.help = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  if (opts.valuesFiles.length === 0) opts.valuesFiles.push(path.join(opts.chart, "values.yaml"));
  return opts;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`validate-helm-release: ${err.message}`);
    return 1;
  }

  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  let manifest;
  let source;
  try {
    if (opts.manifest) {
      manifest = opts.manifest === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(opts.manifest, "utf8");
      source = opts.manifest === "-" ? "stdin" : opts.manifest;
    } else {
      manifest = renderWithHelm(opts);
      source = opts.valuesFiles.join(" + ");
    }
  } catch (err) {
    console.error(`validate-helm-release: ${err.message}`);
    return 1;
  }

  const { network, errors } = validateManifest(manifest, { expectNetwork: opts.expectNetwork });

  if (errors.length > 0) {
    console.error(`\n✖ Refusing to deploy — ${errors.length} problem(s) in the rendered release (${source}):\n`);
    for (const e of errors) console.error(`  • ${e}`);
    console.error("");
    return 1;
  }

  console.log(`✔ Rendered release is consistent for network=${network} (${source})`);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { validateManifest, readManifest, renderWithHelm, main };
