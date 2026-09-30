/**
 * lib/starterAccount.ts — the browser-held key behind the sponsored path.
 *
 * ── Where the key lives, and why that is the whole design ───────────────────
 * A donor with no wallet needs a key from somewhere. The three options are:
 * the platform holds it (custody, which contradicts ADR-002 and everything the
 * rest of the platform is built on), a third party holds it (custody wearing a
 * different hat), or the donor holds it in the only place they have — this
 * browser.
 *
 * So the key is generated here, stored here, and never transmitted. The backend
 * sees the *public* key and nothing else; there is no field in the API or column
 * in the database that could carry a secret even by accident.
 *
 * That choice has a real cost, and the cost is not hidden: a key in browser
 * storage is lost when the browser data is cleared, and nobody can recover it.
 * `STARTER_ACCOUNT_TRADEOFFS` is shown to the donor *before* the account is
 * created, and the flow will not proceed without an explicit acknowledgement.
 *
 * ── Why localStorage and not something cleverer ─────────────────────────────
 * IndexedDB, the Web Crypto non-extractable key store, and a passphrase-derived
 * wrapper all sound better and mostly are not: non-extractable keys cannot be
 * exported, which removes the one mitigation that actually helps (getting the
 * key into a real wallet), and a passphrase reintroduces the "remember a secret
 * or lose everything" problem the donor came here to avoid. What genuinely
 * helps is making export prominent and upgrade easy, which is what the flow
 * does.
 */
import {
  generateStarterKeypair,
  publicKeyFromSecret,
  isValidStellarSecret,
  signWithStarterKey,
  signUpgradeChallenge,
  NETWORK,
} from "./stellar";

/** Namespaced by network so a testnet key can never be used against mainnet. */
const STORAGE_KEY = `greenpay_starter_account_${NETWORK}`;

export interface StarterAccount {
  publicKey: string;
  secret: string;
  createdAt: string;
  /** Set once the donor confirms they have saved the key somewhere else. */
  exportedAt?: string;
  /** Set once the history has been migrated to a full wallet. */
  upgradedTo?: string;
}

/**
 * The trade-offs, stated before the account exists rather than after.
 *
 * Mirrors STARTER_ACCOUNT_DISCLOSURES in the backend so the same words appear
 * whether the client renders them locally or fetches them. Duplication is
 * deliberate: the disclosure must render even if the API is unreachable, and a
 * donor must never be able to create an account without seeing it.
 */
export const STARTER_ACCOUNT_TRADEOFFS = {
  title: "What you get, and what you are giving up",
  keep: [
    "Your donation goes to the project directly, on-chain, exactly like any other donation.",
    "The donation is permanently recorded on Stellar under your address. Nobody, including GreenPay, can undo or reassign it.",
    "You can move your donation history and badges to a full wallet later, for free.",
  ],
  giveUp: [
    "Your key lives in this browser only. Clear your browser data, or use a different device, and it is gone.",
    "GreenPay does not have a copy of your key and cannot restore it. There is no password reset.",
    "If you lose the key you lose access to any XLM left in the account, and your donation history on GreenPay stays attached to an address you can no longer prove you own.",
    "Sponsored accounts have a donation cap. To give more, you will need a wallet you fund yourself.",
  ],
  mitigation: [
    "Export your key now and store it somewhere safe — it works in any Stellar wallet.",
    "Or move to a full wallet as soon as you have one; your history comes with you.",
  ],
} as const;

/**
 * The in-memory copy, and the reason it exists.
 *
 * A private-window browser will accept `setItem` and quietly discard it. If
 * storage were the only source of truth, that donor's key would vanish the
 * instant after it was created and every subsequent signature would fail with
 * "no starter account" — so they could not donate at all, which is the exact
 * outcome this whole feature exists to prevent.
 *
 * Holding the account in memory keeps the *current session* working, while
 * `isPersisted()` still reports the truth so the donor is warned that it will
 * not survive the tab closing. Working now with an honest warning beats failing
 * now with a confusing one.
 */
let memoryAccount: StarterAccount | null = null;

function storage(): Storage | null {
  // Server-side rendering, and browsers with storage disabled, must degrade to
  // "no starter account" rather than throwing during a render.
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Reads the stored starter account, or null. Never throws. */
export function loadStarterAccount(): StarterAccount | null {
  const store = storage();
  if (store) {
    try {
      const raw = store.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StarterAccount;
        // A stored value that is not a usable key is worse than none: it would
        // let the UI offer a "donate" button that can never sign.
        if (parsed?.secret && isValidStellarSecret(parsed.secret)) return parsed;
      }
    } catch {
      // Fall through to the in-memory copy.
    }
  }
  return memoryAccount;
}

/**
 * Creates a starter keypair and persists it.
 *
 * `acknowledged` is required rather than optional. A donor who has not been
 * shown what they are accepting has not accepted it, and making that a type
 * error is cheaper than making it a policy nobody checks.
 */
export function createStarterAccount(acknowledged: true): StarterAccount {
  if (acknowledged !== true) {
    throw new Error("The starter-account trade-offs must be acknowledged before creating a key.");
  }
  const { publicKey, secret } = generateStarterKeypair();
  const account: StarterAccount = { publicKey, secret, createdAt: new Date().toISOString() };
  persist(account);
  return account;
}

/** Imports an existing secret, so a donor can move between devices. */
export function importStarterAccount(secret: string): StarterAccount {
  if (!isValidStellarSecret(secret)) {
    throw new Error("That is not a valid Stellar secret key.");
  }
  const account: StarterAccount = {
    publicKey: publicKeyFromSecret(secret),
    secret,
    createdAt: new Date().toISOString(),
    // An imported key is by definition already held somewhere else.
    exportedAt: new Date().toISOString(),
  };
  persist(account);
  return account;
}

function persist(account: StarterAccount): void {
  memoryAccount = account;
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(account));
  } catch {
    // A full or blocked storage is not fatal for the donation in progress —
    // the key is still in memory for this session. The caller surfaces this
    // through `isPersisted()` so the donor is told before they rely on it.
  }
}

/**
 * Whether the key actually survived being written to disk.
 *
 * Deliberately reads storage directly rather than going through
 * `loadStarterAccount`, which would find the in-memory copy and answer "yes" to
 * a question whose entire purpose is to detect that storage did *not* keep it.
 */
export function isPersisted(): boolean {
  const store = storage();
  if (!store) return false;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as StarterAccount;
    return Boolean(parsed?.secret && isValidStellarSecret(parsed.secret));
  } catch {
    return false;
  }
}

/** Records that the donor has saved the key elsewhere. */
export function markExported(): StarterAccount | null {
  const account = loadStarterAccount();
  if (!account) return null;
  const updated = { ...account, exportedAt: new Date().toISOString() };
  persist(updated);
  return updated;
}

/** Records the wallet a donor's history was migrated to. */
export function markUpgraded(walletAddress: string): StarterAccount | null {
  const account = loadStarterAccount();
  if (!account) return null;
  const updated = { ...account, upgradedTo: walletAddress };
  persist(updated);
  return updated;
}

/**
 * Forgets the key.
 *
 * Deliberately not called automatically after an upgrade: the starter account
 * may still hold a stray balance, and silently discarding the only key to it
 * would destroy funds. The donor clears it when they choose to.
 */
export function forgetStarterAccount(): void {
  memoryAccount = null;
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    // Nothing useful to do; the caller re-reads and sees whether it went.
  }
}

/** Signs a transaction with the stored starter key. */
export function signWithStarterAccount(xdr: string): string {
  const account = loadStarterAccount();
  if (!account) throw new Error("No starter account is stored in this browser.");
  return signWithStarterKey(xdr, account.secret);
}

/** Signs the account-upgrade challenge with the stored starter key. */
export function signUpgradeWithStarterAccount(message: string): string {
  const account = loadStarterAccount();
  if (!account) throw new Error("No starter account is stored in this browser.");
  return signUpgradeChallenge(message, account.secret);
}

/**
 * Whether this donor should be nudged to export or upgrade.
 *
 * The nudge is tied to having something to lose: reminding someone with an
 * empty account to back it up trains them to ignore the warning that matters.
 */
export function shouldPromptExport(account: StarterAccount | null, hasDonated: boolean): boolean {
  if (!account) return false;
  if (account.exportedAt) return false;
  return hasDonated;
}
