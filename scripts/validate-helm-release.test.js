#!/usr/bin/env node
/**
 * scripts/validate-helm-release.test.js
 *
 * Regression tests for the Helm pre-deploy guard.
 *
 * These run the guard the way CI and an operator run it — `helm template` over
 * the committed chart, then assertions on the rendered output. The negative
 * cases are the point: each one is a real way a mainnet release has gone wrong
 * (stale testnet URL, default password, placeholder host, wrong environment
 * entirely), and the guard has to reject each of them.
 *
 * Run: node --test scripts/validate-helm-release.test.js
 * (needs Helm 3 on PATH, or HELM_BIN pointing at it)
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const GUARD = path.join(ROOT, "scripts", "validate-helm-release.js");
const CHART = path.join(ROOT, "helm", "greenpay");
const BASE = path.join(CHART, "values.yaml");
const MAINNET = path.join(CHART, "values-mainnet.yaml");
const CI_VALUES = path.join(CHART, "ci", "mainnet-render-check.yaml");

/** Run the guard as a subprocess, exactly as CI does. */
function runGuard(args, { stdin } = {}) {
  const result = spawnSync(process.execPath, [GUARD, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    input: stdin,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { code: result.status, out: result.stdout || "", err: result.stderr || "" };
}

/** A fully-specified mainnet release: overlay plus the deploy-time values. */
const MAINNET_RELEASE = ["-f", BASE, "-f", MAINNET, "-f", CI_VALUES, "--expect-network", "mainnet"];

test("committed testnet defaults pass as testnet", () => {
  const { code, out } = runGuard(["-f", BASE, "--expect-network", "testnet"]);
  assert.strictEqual(code, 0, `guard rejected the base defaults:\n${out}`);
  assert.match(out, /network=testnet/);
});

test("committed mainnet overlay plus deploy-time values passes as mainnet", () => {
  const { code, out, err } = runGuard(MAINNET_RELEASE);
  assert.strictEqual(code, 0, `guard rejected a valid mainnet release:\n${err}`);
  assert.match(out, /network=mainnet/);
});

test("mainnet overlay alone is rejected: deploy-time values are still empty", () => {
  const { code, err } = runGuard(["-f", BASE, "-f", MAINNET, "--expect-network", "mainnet"]);
  assert.strictEqual(code, 1, "overlay with empty contract id / host must not be deployable");
  assert.match(err, /CONTRACT_ID is empty/);
  assert.match(err, /ingress host is \(empty\)/);
});

test("mainnet combined with a testnet Horizon URL is rejected", () => {
  const { code, err } = runGuard([
    ...MAINNET_RELEASE,
    "--set", "config.horizonUrl=https://horizon-testnet.stellar.org",
  ]);
  assert.strictEqual(code, 1);
  assert.match(err, /mainnet but HORIZON_URL=https:\/\/horizon-testnet\.stellar\.org is not a pubnet endpoint/);
});

test("mainnet combined with a testnet Soroban RPC URL is rejected", () => {
  const { code, err } = runGuard([
    ...MAINNET_RELEASE,
    "--set", "config.sorobanRpcUrl=https://soroban-testnet.stellar.org",
  ]);
  assert.strictEqual(code, 1);
  assert.match(err, /mainnet but SOROBAN_RPC_URL=.*testnet.* is not a pubnet endpoint/);
});

test("mainnet with an inline secret and no password is rejected", () => {
  // Forcing inline on mainnet (the overlay uses External Secrets) must not
  // ship an empty or default password. Nothing production-shaped is in git.
  const { code, err } = runGuard([
    ...MAINNET_RELEASE,
    "--set", "secrets.provider=inline",
    "--set", "secrets.existingSecret=",
  ]);
  assert.strictEqual(code, 1);
  assert.match(err, /POSTGRES_PASSWORD is 0 characters/);
});

test("mainnet combined with a known-default password is rejected", () => {
  const { code, err } = runGuard([
    ...MAINNET_RELEASE,
    "--set", "secrets.provider=inline",
    "--set", "secrets.existingSecret=",
    "--set", "secrets.postgresPassword=changeme",
  ]);
  assert.strictEqual(code, 1);
  assert.match(err, /POSTGRES_PASSWORD is the default value "changeme"/);
  assert.match(err, /DATABASE_URL embeds a default password/);
});

test("mainnet combined with a short non-default password is rejected", () => {
  const { code, err } = runGuard([
    ...MAINNET_RELEASE,
    "--set", "secrets.provider=inline",
    "--set", "secrets.existingSecret=",
    "--set", "secrets.postgresPassword=hunter2",
    "--set", "secrets.adminApiKey=an-admin-key-value",
  ]);
  assert.strictEqual(code, 1);
  assert.match(err, /POSTGRES_PASSWORD is 7 characters/);
});

test("mainnet with a strong inline password and admin key is accepted", () => {
  const { code, out } = runGuard([
    ...MAINNET_RELEASE,
    "--set", "secrets.provider=inline",
    "--set", "secrets.existingSecret=",
    "--set", "secrets.postgresPassword=a-sufficiently-long-db-password",
    "--set", "secrets.adminApiKey=a-sufficiently-long-admin-key",
  ]);
  assert.strictEqual(code, 0, out);
});

test("mainnet combined with the greenpay.local placeholder host is rejected", () => {
  const { code, err } = runGuard([...MAINNET_RELEASE, "--set", "ingress.host=greenpay.local"]);
  assert.strictEqual(code, 1);
  assert.match(err, /ingress host is greenpay\.local/);
});

test("mainnet without ingress TLS is rejected", () => {
  const { code, err } = runGuard([...MAINNET_RELEASE, "--set", "ingress.tls.enabled=false"]);
  assert.strictEqual(code, 1);
  assert.match(err, /has no tls block/);
  assert.match(err, /ALLOWED_ORIGINS=http:\/\/.* is not https/);
});

test("mainnet with an empty or malformed contract id is rejected", () => {
  const empty = runGuard([...MAINNET_RELEASE, "--set", "config.contractId="]);
  assert.strictEqual(empty.code, 1);
  assert.match(empty.err, /CONTRACT_ID is empty/);

  const malformed = runGuard([...MAINNET_RELEASE, "--set", "config.contractId=not-a-contract-id"]);
  assert.strictEqual(malformed.code, 1);
  assert.match(malformed.err, /not a well-formed Stellar contract id/);
});

test("testnet combined with a pubnet Horizon URL is rejected", () => {
  // The mismatch in the other direction: testnet release, mainnet endpoint.
  const { code, err } = runGuard([
    "-f", BASE,
    "--expect-network", "testnet",
    "--set", "config.horizonUrl=https://horizon.stellar.org",
  ]);
  assert.strictEqual(code, 1);
  assert.match(err, /testnet but HORIZON_URL=https:\/\/horizon\.stellar\.org is a pubnet endpoint/);
});

test("deploying testnet values while expecting mainnet is rejected", () => {
  // The stale-values case: an operator runs the mainnet deploy but the values
  // files in hand are still the testnet defaults.
  const { code, err } = runGuard(["-f", BASE, "--expect-network", "mainnet"]);
  assert.strictEqual(code, 1);
  assert.match(err, /renders STELLAR_NETWORK=testnet but the deploy expects mainnet/);
});

test("SOROBAN_RPC_URL is rendered for the backend, not just the frontend", () => {
  // backend/src/services/stellar.js silently defaults to the testnet RPC when
  // this key is absent, so its absence is a mainnet downgrade.
  const helm = process.env.HELM_BIN || "helm";
  const rendered = spawnSync(helm, ["template", "greenpay", CHART, "-f", BASE, "-f", MAINNET, "-f", CI_VALUES], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.strictEqual(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /^ {2}SOROBAN_RPC_URL: https:\/\/soroban\.stellar\.org$/m);
});

test("a manifest whose backend and frontend disagree on the network is rejected", () => {
  // Not reachable through the values files today — both keys come from
  // config.stellarNetwork — but reachable through template drift or a
  // hand-edited release, which is exactly what --manifest is for.
  const manifest = [
    "apiVersion: v1",
    "kind: ConfigMap",
    "metadata:",
    "  name: greenpay-config",
    "  namespace: greenpay",
    "data:",
    "  STELLAR_NETWORK: mainnet",
    "  HORIZON_URL: https://horizon.stellar.org",
    "  SOROBAN_RPC_URL: https://soroban.stellar.org",
    "  ALLOWED_ORIGINS: \"https://app.greenpay.org\"",
    "  EMAIL_FROM: \"GreenPay <updates@greenpay.org>\"",
    "  CONTRACT_ID: \"CADPZJDGZXQCZM4E4C3P42TRPCXOJTHOI4RTZQCV3IOMHFXQPBHQ7UGH\"",
    "  NEXT_PUBLIC_STELLAR_NETWORK: testnet",
    "  NEXT_PUBLIC_HORIZON_URL: https://horizon-testnet.stellar.org",
    "  NEXT_PUBLIC_SOROBAN_RPC_URL: https://soroban-testnet.stellar.org",
    "  NEXT_PUBLIC_CONTRACT_ID: \"CADPZJDGZXQCZM4E4C3P42TRPCXOJTHOI4RTZQCV3IOMHFXQPBHQ7UGH\"",
    "  NEXT_PUBLIC_USDC_ISSUER: \"GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN\"",
    "---",
    "apiVersion: networking.k8s.io/v1",
    "kind: Ingress",
    "metadata:",
    "  name: greenpay-ingress",
    "spec:",
    "  tls:",
    "    - hosts:",
    "        - app.greenpay.org",
    "      secretName: greenpay-tls",
    "  rules:",
    "    - host: app.greenpay.org",
    "",
  ].join("\n");

  const { code, err } = runGuard(["--manifest", "-"], { stdin: manifest });
  assert.strictEqual(code, 1);
  assert.match(err, /backend\/frontend network mismatch/);
  assert.match(err, /backend\/frontend Horizon mismatch/);
});

test("the guard fails loudly when the chart no longer renders what it checks", () => {
  // A guard that silently finds nothing and reports success is worse than none.
  const { code, err } = runGuard(["--manifest", "-"], { stdin: "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: greenpay\n" });
  assert.strictEqual(code, 1);
  assert.match(err, /cannot verify this release/);
});
