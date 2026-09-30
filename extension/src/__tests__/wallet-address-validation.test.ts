/**
 * __tests__/wallet-address-validation.test.ts
 *
 * Regression tests for Issue #339 — the donation destination address
 * (project.walletAddress) must be StrKey-validated at every point where
 * untrusted data enters the extension:
 *
 *   1. isValidStellarAddress() — the exported helper itself.
 *   2. toProjectSummary()-equivalent via WorkerSessionState.setProjects() —
 *      invalid addresses must be filtered out of the cache before persisting.
 *   3. Cache rehydration — a poisoned chrome.storage.local entry whose
 *      walletAddress fails the checksum must be rejected on load.
 *
 * Address corpus used throughout:
 *
 *   VALID_ADDRESS   — a real checksum-valid Ed25519 G… key (56 chars).
 *   SHORT_ADDRESS   — the same key truncated to 55 chars (near-miss).
 *   EMPTY_ADDRESS   — empty string.
 *   CORRUPT_ADDRESS — 56-char key with the last character changed to break
 *                     the checksum.  Passes a naive regex check (starts with
 *                     G, length 56, base32 alphabet) but fails StrKey decode.
 */
import { describe, expect, it } from 'vitest';
import {
  isValidStellarAddress,
  WorkerSessionState,
  SESSION_SCHEMA_VERSION,
  STORAGE_KEYS,
  PROJECT_CACHE_TTL_MS,
  type StorageArea,
} from '../session-state';

// ── Address corpus ────────────────────────────────────────────────────────────

/** Real, checksum-valid Stellar Ed25519 public key. */
const VALID_ADDRESS   = 'GDUQ24STT6QESP4QW33O4KDVYMRTBHWZ3ZE6HXX5TCNWUZH6MRT7PADV';

/** 55-character near-miss — one character short of the required 56. */
const SHORT_ADDRESS   = VALID_ADDRESS.slice(0, -1);

/** Empty string — the old default when walletAddress was missing. */
const EMPTY_ADDRESS   = '';

/**
 * 56-character string that starts with G and uses only base-32 characters
 * but has an invalid checksum — the last character was changed from V to X.
 * This is the most dangerous case: it passes a naive /^G[A-Z2-7]{55}$/ regex
 * but the Horizon payment operation would reject or misroute it.
 */
const CORRUPT_ADDRESS = VALID_ADDRESS.slice(0, -1) + 'X';

/** A valid donor public key, distinct from any wallet address. */
const DONOR_KEY       = 'GDURNRYPVUSN6G6CN4ICPNUZFVUTPLY5OB45OC7SPVGY43KED443Q525';

// ── Minimal in-memory StorageArea (mirrors session-recovery.test.ts) ─────────

class MemoryStorage implements StorageArea {
  readonly values: Record<string, unknown> = {};

  async get(keys?: string | string[] | Record<string, unknown> | null) {
    if (typeof keys === 'string') return { [keys]: this.values[keys] };
    if (Array.isArray(keys))
      return Object.fromEntries(keys.map((k) => [k, this.values[k]]));
    return { ...this.values };
  }
  async set(items: Record<string, unknown>) {
    Object.assign(this.values, items);
  }
  async remove(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) delete this.values[k];
  }
}

// ── Helper: build a minimal valid project with a given walletAddress ──────────

function makeProject(walletAddress: string) {
  return {
    id: 'proj-1',
    name: 'Test Project',
    description: 'Test',
    category: 'Reforestation',
    walletAddress,
  };
}

// ── 1. isValidStellarAddress() unit tests ────────────────────────────────────

describe('isValidStellarAddress', () => {
  it('accepts a real, checksum-valid Ed25519 public key', () => {
    expect(isValidStellarAddress(VALID_ADDRESS)).toBe(true);
  });

  it('accepts a second distinct valid key', () => {
    expect(isValidStellarAddress(DONOR_KEY)).toBe(true);
  });

  it('rejects a 55-character near-miss (one char short)', () => {
    expect(isValidStellarAddress(SHORT_ADDRESS)).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidStellarAddress(EMPTY_ADDRESS)).toBe(false);
  });

  it('rejects a 56-char string with a valid format but invalid checksum', () => {
    // This is the critical case: the corrupted address has the right length
    // and character set but the StrKey checksum doesn't match.
    expect(isValidStellarAddress(CORRUPT_ADDRESS)).toBe(false);
  });

  it('rejects null', () => {
    expect(isValidStellarAddress(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isValidStellarAddress(undefined)).toBe(false);
  });

  it('rejects a number', () => {
    expect(isValidStellarAddress(12345)).toBe(false);
  });

  it('rejects a Muxed address (M…) — only G… keys are supported', () => {
    // Muxed addresses start with M and are longer than 56 chars.
    // They are valid StrKey encodings of a different type (Med25519) but
    // the extension only accepts Ed25519 (G…) destinations.
    const muxed = 'MA7QYNF7SOWQ3GLR2BGMZEHXR4WDKCP53VKZSGZYDSKAFQFIXZH2CDNCXW';
    expect(isValidStellarAddress(muxed)).toBe(false);
  });
});

// ── 2. Ingestion filter (WorkerSessionState.setProjects) ─────────────────────

describe('WorkerSessionState.setProjects — walletAddress validation at ingestion', () => {
  it('persists a project with a valid walletAddress', async () => {
    const session = new MemoryStorage();
    const local   = new MemoryStorage();
    const state   = new WorkerSessionState(session, local, () => 1_000, 'worker-1');

    const result = await state.setProjects([makeProject(VALID_ADDRESS)]);

    expect(result).toHaveLength(1);
    expect(result[0].walletAddress).toBe(VALID_ADDRESS);
  });

  it('drops a project whose walletAddress is an empty string', async () => {
    const session = new MemoryStorage();
    const local   = new MemoryStorage();
    const state   = new WorkerSessionState(session, local, () => 1_000, 'worker-2');

    const result = await state.setProjects([makeProject(EMPTY_ADDRESS)]);

    expect(result).toHaveLength(0);
  });

  it('drops a project with a 55-char near-miss walletAddress', async () => {
    const session = new MemoryStorage();
    const local   = new MemoryStorage();
    const state   = new WorkerSessionState(session, local, () => 1_000, 'worker-3');

    const result = await state.setProjects([makeProject(SHORT_ADDRESS)]);

    expect(result).toHaveLength(0);
  });

  it('drops a project with a checksum-invalid 56-char walletAddress', async () => {
    const session = new MemoryStorage();
    const local   = new MemoryStorage();
    const state   = new WorkerSessionState(session, local, () => 1_000, 'worker-4');

    const result = await state.setProjects([makeProject(CORRUPT_ADDRESS)]);

    expect(result).toHaveLength(0);
  });

  it('keeps valid projects and drops invalid ones in a mixed batch', async () => {
    const session = new MemoryStorage();
    const local   = new MemoryStorage();
    const state   = new WorkerSessionState(session, local, () => 1_000, 'worker-5');

    const valid1  = { ...makeProject(VALID_ADDRESS),  id: 'good-1' };
    const invalid = { ...makeProject(CORRUPT_ADDRESS), id: 'bad-1'  };
    const valid2  = { ...makeProject(DONOR_KEY),       id: 'good-2' };

    const result = await state.setProjects([valid1, invalid, valid2]);

    expect(result).toHaveLength(2);
    expect(result.map((p) => p.id)).toEqual(['good-1', 'good-2']);
  });

  it('does not write invalid projects to localStorage', async () => {
    const session = new MemoryStorage();
    const local   = new MemoryStorage();
    const state   = new WorkerSessionState(session, local, () => 1_000, 'worker-6');

    await state.setProjects([makeProject(CORRUPT_ADDRESS)]);

    const stored = local.values[STORAGE_KEYS.projects] as {
      projects: unknown[];
    };
    expect(stored.projects).toHaveLength(0);
  });
});

// ── 3. Cache rehydration — poisoned chrome.storage.local entries ──────────────

describe('WorkerSessionState cache rehydration — poisoned walletAddress rejected', () => {
  it('rejects a cached project with a checksum-invalid walletAddress on load', async () => {
    const session = new MemoryStorage();
    const local   = new MemoryStorage();
    const now     = () => 1_000;

    // Directly write a poisoned cache entry (simulates an attacker or a
    // corrupted write that bypassed the setProjects validation path).
    local.values[STORAGE_KEYS.projects] = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      cachedAt: now(),
      projects: [makeProject(CORRUPT_ADDRESS)],
    };

    const state    = new WorkerSessionState(session, local, now, 'worker-poison');
    const snapshot = await state.snapshot(null);

    // The poisoned cache must be rejected — projects should be null,
    // not an array containing the bad entry.
    expect(snapshot.projects).toBeNull();
    // The bad entry must also be evicted from storage.
    expect(local.values[STORAGE_KEYS.projects]).toBeUndefined();
  });

  it('rejects a cached project with an empty walletAddress on load', async () => {
    const session = new MemoryStorage();
    const local   = new MemoryStorage();
    const now     = () => 1_000;

    local.values[STORAGE_KEYS.projects] = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      cachedAt: now(),
      projects: [makeProject(EMPTY_ADDRESS)],
    };

    const state    = new WorkerSessionState(session, local, now, 'worker-empty');
    const snapshot = await state.snapshot(null);

    expect(snapshot.projects).toBeNull();
    expect(local.values[STORAGE_KEYS.projects]).toBeUndefined();
  });

  it('accepts a cached project with a valid walletAddress on load', async () => {
    const session = new MemoryStorage();
    const local   = new MemoryStorage();
    const now     = () => 1_000;

    local.values[STORAGE_KEYS.projects] = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      cachedAt: now(),
      projects: [makeProject(VALID_ADDRESS)],
    };

    const state    = new WorkerSessionState(session, local, now, 'worker-valid');
    const snapshot = await state.snapshot(null);

    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects![0].walletAddress).toBe(VALID_ADDRESS);
  });

  it('rejects the entire cache when any one project has an invalid address', async () => {
    const session = new MemoryStorage();
    const local   = new MemoryStorage();
    const now     = () => 1_000;

    // One good, one bad — the bad entry causes .every(isProject) to fail,
    // so the whole cache is dropped.
    local.values[STORAGE_KEYS.projects] = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      cachedAt: now(),
      projects: [makeProject(VALID_ADDRESS), makeProject(CORRUPT_ADDRESS)],
    };

    const state    = new WorkerSessionState(session, local, now, 'worker-mixed');
    const snapshot = await state.snapshot(null);

    expect(snapshot.projects).toBeNull();
  });

  it('rejects a cache entry that has not yet expired but contains a near-miss address', async () => {
    const session = new MemoryStorage();
    const local   = new MemoryStorage();
    // Within TTL so expiry is not the rejection reason.
    const now     = () => PROJECT_CACHE_TTL_MS / 2;

    local.values[STORAGE_KEYS.projects] = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      cachedAt: 1_000,
      projects: [makeProject(SHORT_ADDRESS)],
    };

    const state    = new WorkerSessionState(session, local, now, 'worker-near-miss');
    const snapshot = await state.snapshot(null);

    expect(snapshot.projects).toBeNull();
  });
});
