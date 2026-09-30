/**
 * __tests__/starterAccount.test.ts
 *
 * The device-held key is the part of the design that trades safety for reach,
 * so these tests are mostly about the properties that keep the trade honest:
 * the key never leaves the device, the disclosure is unavoidable, and the
 * keychain is used with the options that make "this device only" true.
 */
import * as SecureStore from 'expo-secure-store';
import { Keypair, Networks, Transaction } from '@stellar/stellar-sdk';
import {
  STARTER_ACCOUNT_KEY,
  STARTER_ACCOUNT_TRADEOFFS,
  createStarterAccount,
  loadStarterAccount,
  importStarterAccount,
  forgetStarterAccount,
  markExported,
  markUpgraded,
  signWithStarterAccount,
  signUpgradeChallenge,
  shouldPromptExport,
  isStarterAddress,
  isValidStellarSecret,
} from '../utils/starterAccount';

/**
 * Every test here does real ed25519 work through @stellar/stellar-sdk, and the
 * first one also pays the cost of loading it through the jest-expo transform.
 * Jest's 5s default leaves no headroom for that on a contended CI runner — see
 * the note in FirstDonationPaths.test.tsx for the full reasoning.
 */
jest.setTimeout(30000);

beforeEach(async () => {
  jest.clearAllMocks();
  await forgetStarterAccount();
});

describe('STARTER_ACCOUNT_TRADEOFFS', () => {
  it('says GreenPay cannot recover the key', () => {
    const text = STARTER_ACCOUNT_TRADEOFFS.giveUp.join(' ');
    expect(text).toMatch(/does not have a copy of it/i);
    expect(text).toMatch(/no password reset/i);
  });

  it('describes the mobile reality, not the browser one', () => {
    // Telling a mobile donor their key vanishes when they clear their browser
    // data would be false, and a disclosure that is wrong in the donor's
    // favour is still wrong.
    const text = STARTER_ACCOUNT_TRADEOFFS.giveUp.join(' ');
    expect(text).not.toMatch(/browser/i);
    expect(text).toMatch(/not backed up to iCloud or Google/i);
    expect(text).toMatch(/will not follow you to a new phone/i);
  });

  it('credits the keychain, which is a genuinely stronger position than the web', () => {
    expect(STARTER_ACCOUNT_TRADEOFFS.keep.join(' ')).toMatch(/secure keychain/i);
  });

  it('offers a mitigation rather than only a warning', () => {
    expect(STARTER_ACCOUNT_TRADEOFFS.mitigation.join(' ')).toMatch(/export your key/i);
  });
});

describe('createStarterAccount', () => {
  it('creates a real, usable Stellar keypair', async () => {
    const account = await createStarterAccount(true);
    expect(account.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
    expect(Keypair.fromSecret(account.secret).publicKey()).toBe(account.publicKey);
  });

  it('stores it with the strictest keychain protection available', async () => {
    // WHEN_UNLOCKED_THIS_DEVICE_ONLY keeps the key out of backups, which is
    // what makes the "this device only" disclosure true rather than aspirational.
    await createStarterAccount(true);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      STARTER_ACCOUNT_KEY,
      expect.any(String),
      expect.objectContaining({ keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }),
    );
  });

  it('namespaces storage by network so a testnet key cannot be used on mainnet', () => {
    expect(STARTER_ACCOUNT_KEY).toMatch(/testnet$/);
  });

  it('refuses to create a key without an acknowledgement', async () => {
    // Typed as `true` so this is normally a compile error; the runtime guard
    // covers the JavaScript caller the type system cannot reach.
    await expect(createStarterAccount(false as unknown as true)).rejects.toThrow(/acknowledged/i);
  });

  it('round-trips through the keychain', async () => {
    const created = await createStarterAccount(true);
    const loaded = await loadStarterAccount();
    expect(loaded?.publicKey).toBe(created.publicKey);
    expect(loaded?.secret).toBe(created.secret);
  });
});

describe('loadStarterAccount', () => {
  it('returns null when nothing is stored', async () => {
    await expect(loadStarterAccount()).resolves.toBeNull();
  });

  it('returns null for corrupt data rather than throwing during a render', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValueOnce('{not json');
    await expect(loadStarterAccount()).resolves.toBeNull();
  });

  it('returns null for a stored value that is not a usable key', async () => {
    // Worse than nothing: it would let the UI offer a donate button that can
    // never sign.
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValueOnce(
      JSON.stringify({ publicKey: 'G'.repeat(56), secret: 'not-a-secret' }),
    );
    await expect(loadStarterAccount()).resolves.toBeNull();
  });

  it('returns null when the keychain read itself fails', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockRejectedValueOnce(new Error('keychain locked'));
    await expect(loadStarterAccount()).resolves.toBeNull();
  });
});

describe('importStarterAccount', () => {
  it('recovers an account from its secret', async () => {
    const keypair = Keypair.random();
    const imported = await importStarterAccount(keypair.secret());
    expect(imported.publicKey).toBe(keypair.publicKey());
  });

  it('treats an imported key as already backed up', async () => {
    const imported = await importStarterAccount(Keypair.random().secret());
    expect(imported.exportedAt).toBeDefined();
  });

  it('rejects something that is not a secret key', async () => {
    await expect(importStarterAccount('hello')).rejects.toThrow(/valid Stellar secret key/i);
  });
});

describe('signing', () => {
  it('signs a transaction envelope with the stored key', async () => {
    const account = await createStarterAccount(true);
    const unsigned = buildDummyTransaction(account.publicKey);

    const signed = await signWithStarterAccount(unsigned, Networks.TESTNET);
    const tx = new Transaction(signed, Networks.TESTNET);

    expect(tx.signatures).toHaveLength(1);
    expect(
      Keypair.fromPublicKey(account.publicKey).verify(tx.hash(), tx.signatures[0].signature()),
    ).toBe(true);
  });

  it('refuses to sign when no key is stored', async () => {
    await expect(signWithStarterAccount('AAAA', Networks.TESTNET)).rejects.toThrow(
      /No starter account/i,
    );
  });

  it('produces an upgrade signature that verifies against the stored address', async () => {
    const account = await createStarterAccount(true);
    const message = 'GreenPay account upgrade\nnonce:abc';

    const signature = await signUpgradeChallenge(message);

    expect(
      Keypair.fromPublicKey(account.publicKey).verify(
        Buffer.from(message, 'utf8'),
        Buffer.from(signature, 'base64'),
      ),
    ).toBe(true);
  });

  it('produces a signature that does not verify for different text', async () => {
    const account = await createStarterAccount(true);
    const signature = await signUpgradeChallenge('one thing');
    expect(
      Keypair.fromPublicKey(account.publicKey).verify(
        Buffer.from('another thing', 'utf8'),
        Buffer.from(signature, 'base64'),
      ),
    ).toBe(false);
  });
});

describe('lifecycle markers', () => {
  it('records that the key was exported', async () => {
    await createStarterAccount(true);
    expect((await markExported())?.exportedAt).toBeDefined();
  });

  it('records the wallet the history moved to', async () => {
    await createStarterAccount(true);
    const wallet = Keypair.random().publicKey();
    expect((await markUpgraded(wallet))?.upgradedTo).toBe(wallet);
  });

  it('keeps the key after an upgrade, because it may still hold a balance', async () => {
    // Silently discarding the only key to an account with funds in it would
    // destroy those funds.
    const account = await createStarterAccount(true);
    await markUpgraded(Keypair.random().publicKey());
    expect((await loadStarterAccount())?.secret).toBe(account.secret);
  });

  it('forgets the key only when asked', async () => {
    await createStarterAccount(true);
    await forgetStarterAccount();
    await expect(loadStarterAccount()).resolves.toBeNull();
  });
});

describe('shouldPromptExport', () => {
  it('stays quiet until the donor has something to lose', async () => {
    // Reminding someone with an empty account to back it up trains them to
    // ignore the warning that matters.
    expect(shouldPromptExport(await createStarterAccount(true), false)).toBe(false);
  });

  it('prompts once a donation has been made', async () => {
    expect(shouldPromptExport(await createStarterAccount(true), true)).toBe(true);
  });

  it('stops prompting once the key has been exported', async () => {
    await createStarterAccount(true);
    expect(shouldPromptExport(await markExported(), true)).toBe(false);
  });

  it('never prompts when there is no account', () => {
    expect(shouldPromptExport(null, true)).toBe(false);
  });
});

describe('isStarterAddress', () => {
  it('recognises the device key', async () => {
    const account = await createStarterAccount(true);
    expect(isStarterAddress(account, account.publicKey)).toBe(true);
  });

  it('does not claim an unrelated wallet', async () => {
    const account = await createStarterAccount(true);
    expect(isStarterAddress(account, Keypair.random().publicKey())).toBe(false);
  });

  it('is false for a malformed or absent address', async () => {
    const account = await createStarterAccount(true);
    expect(isStarterAddress(account, 'not-an-address')).toBe(false);
    expect(isStarterAddress(account, null)).toBe(false);
    expect(isStarterAddress(null, account.publicKey)).toBe(false);
  });
});

describe('isValidStellarSecret', () => {
  it('accepts a real secret and rejects anything else', () => {
    expect(isValidStellarSecret(Keypair.random().secret())).toBe(true);
    expect(isValidStellarSecret('SABC')).toBe(false);
    expect(isValidStellarSecret('')).toBe(false);
  });
});

function buildDummyTransaction(publicKey: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Account, Asset, Operation, TransactionBuilder } = require('@stellar/stellar-sdk');
  return new TransactionBuilder(new Account(publicKey, '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination: publicKey, asset: Asset.native(), amount: '1' }))
    .setTimeout(60)
    .build()
    .toXDR();
}
