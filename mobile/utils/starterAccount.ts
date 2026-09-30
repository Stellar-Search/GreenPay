/**
 * utils/starterAccount.ts
 *
 * The device-held key behind the sponsored onboarding path on mobile.
 *
 * ── Why this is not custody ─────────────────────────────────────────────────
 * A donor with no wallet needs a key from somewhere. Either the platform holds
 * it (custody, which contradicts everything else this app is built on), or the
 * donor does. So the key is generated on the device, stored in the platform
 * keystore, and never transmitted. The backend sees the public key and nothing
 * else.
 *
 * ── Why mobile gets a better deal than the web ──────────────────────────────
 * The web version of this key lives in `localStorage`: readable by any script
 * on the origin, gone when site data is cleared. Here it lives in
 * expo-secure-store, which is the iOS Keychain and the Android Keystore —
 * hardware-backed where available, encrypted at rest, and not readable by other
 * apps. That is a genuinely stronger position, and the disclosure below says so
 * rather than reusing the web's warnings unchanged. It does *not* make the key
 * recoverable, and that part is stated just as plainly.
 *
 * The keychain options mirror utils/walletKeyStorage.ts deliberately:
 * WHEN_UNLOCKED_THIS_DEVICE_ONLY keeps the key out of iCloud backups and off
 * any restored device, so "this key exists on one device" stays true rather
 * than being quietly untrue after a phone migration.
 */
import * as SecureStore from 'expo-secure-store';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { getExpectedNetworkLabel } from './stellarNetwork';

/** Namespaced by network so a testnet key can never be used against mainnet. */
export const STARTER_ACCOUNT_KEY = `greenpay_starter_account_${getExpectedNetworkLabel()}`;

const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export interface StarterAccount {
  publicKey: string;
  secret: string;
  createdAt: string;
  exportedAt?: string;
  upgradedTo?: string;
}

/**
 * The trade-offs, shown before the account exists rather than after.
 *
 * Deliberately not identical to the web copy: telling a mobile donor their key
 * will vanish when they clear their browser data would be false, and a
 * disclosure that is wrong in the donor's favour is still wrong.
 */
export const STARTER_ACCOUNT_TRADEOFFS = {
  title: 'What you get, and what you are giving up',
  keep: [
    'Your donation goes to the project directly, on-chain, exactly like any other donation.',
    'The donation is permanently recorded on Stellar under your address. Nobody, including GreenPay, can undo or reassign it.',
    'Your key is stored in this device’s secure keychain, not in the app’s ordinary storage.',
    'You can move your donation history and badges to a full wallet later, for free.',
  ],
  giveUp: [
    'The key exists on this device only. It is not backed up to iCloud or Google, and it will not follow you to a new phone.',
    'GreenPay does not have a copy of it and cannot restore it. There is no password reset.',
    'Lose the device without exporting the key and you lose access to any XLM left in the account.',
    'Sponsored accounts have a donation cap. To give more, you will need a wallet you fund yourself.',
  ],
  mitigation: [
    'Export your key and store it in a password manager — it works in any Stellar wallet.',
    'Or move to a full wallet as soon as you have one; your history comes with you.',
  ],
} as const;

/** True when a string is a well-formed Stellar secret key. */
export function isValidStellarSecret(secret: string): boolean {
  try {
    Keypair.fromSecret(secret);
    return true;
  } catch {
    return false;
  }
}

/** Reads the stored starter account, or null. Never throws. */
export async function loadStarterAccount(): Promise<StarterAccount | null> {
  try {
    const raw = await SecureStore.getItemAsync(STARTER_ACCOUNT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StarterAccount;
    // A stored value that is not a usable key is worse than none: it would let
    // the UI offer a donate button that can never sign.
    if (!parsed?.secret || !isValidStellarSecret(parsed.secret)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Creates a starter keypair and stores it in the keychain.
 *
 * `acknowledged` is required rather than optional: a donor who has not been
 * shown what they are accepting has not accepted it, and a type error is a
 * cheaper guard than a policy nobody checks.
 */
export async function createStarterAccount(acknowledged: true): Promise<StarterAccount> {
  if (acknowledged !== true) {
    throw new Error('The starter-account trade-offs must be acknowledged before creating a key.');
  }
  const keypair = Keypair.random();
  const account: StarterAccount = {
    publicKey: keypair.publicKey(),
    secret: keypair.secret(),
    createdAt: new Date().toISOString(),
  };
  await persist(account);
  return account;
}

/** Imports an existing secret, so a donor can move between devices. */
export async function importStarterAccount(secret: string): Promise<StarterAccount> {
  if (!isValidStellarSecret(secret)) {
    throw new Error('That is not a valid Stellar secret key.');
  }
  const account: StarterAccount = {
    publicKey: Keypair.fromSecret(secret).publicKey(),
    secret,
    createdAt: new Date().toISOString(),
    // An imported key is by definition already held somewhere else.
    exportedAt: new Date().toISOString(),
  };
  await persist(account);
  return account;
}

async function persist(account: StarterAccount): Promise<void> {
  await SecureStore.setItemAsync(
    STARTER_ACCOUNT_KEY,
    JSON.stringify(account),
    SECURE_STORE_OPTIONS,
  );
}

/** Records that the donor has saved the key somewhere else. */
export async function markExported(): Promise<StarterAccount | null> {
  const account = await loadStarterAccount();
  if (!account) return null;
  const updated = { ...account, exportedAt: new Date().toISOString() };
  await persist(updated);
  return updated;
}

/** Records the wallet a donor's history was migrated to. */
export async function markUpgraded(walletAddress: string): Promise<StarterAccount | null> {
  const account = await loadStarterAccount();
  if (!account) return null;
  const updated = { ...account, upgradedTo: walletAddress };
  await persist(updated);
  return updated;
}

/**
 * Forgets the key.
 *
 * Never called automatically after an upgrade: the starter account may still
 * hold a stray balance, and discarding the only key to it would destroy funds.
 */
export async function forgetStarterAccount(): Promise<void> {
  await SecureStore.deleteItemAsync(STARTER_ACCOUNT_KEY);
}

/** Signs a transaction envelope with the stored starter key. */
export async function signWithStarterAccount(
  xdr: string,
  networkPassphrase: string,
): Promise<string> {
  const account = await loadStarterAccount();
  if (!account) throw new Error('No starter account is stored on this device.');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Transaction } = require('@stellar/stellar-sdk');
  const tx = new Transaction(xdr, networkPassphrase);
  tx.sign(Keypair.fromSecret(account.secret));
  return tx.toXDR();
}

/** Signs the account-upgrade challenge text with the stored starter key. */
export async function signUpgradeChallenge(message: string): Promise<string> {
  const account = await loadStarterAccount();
  if (!account) throw new Error('No starter account is stored on this device.');
  return Keypair.fromSecret(account.secret)
    .sign(Buffer.from(message, 'utf8'))
    .toString('base64');
}

/**
 * Whether this donor should be nudged to export or upgrade.
 *
 * Tied to having something to lose: reminding someone with an empty account to
 * back it up trains them to ignore the warning that matters.
 */
export function shouldPromptExport(account: StarterAccount | null, hasDonated: boolean): boolean {
  if (!account) return false;
  if (account.exportedAt) return false;
  return hasDonated;
}

/** True when the address belongs to the starter account on this device. */
export function isStarterAddress(account: StarterAccount | null, address: string | null): boolean {
  if (!account || !address) return false;
  if (!StrKey.isValidEd25519PublicKey(address)) return false;
  return account.publicKey === address;
}
