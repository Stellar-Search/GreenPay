import { validateManifest, getManifest, getConnectSrcUrls } from '../index';
import { NetworkManifest } from '../schema';
import testnetManifest from '../testnet.json';
import mainnetManifest from '../mainnet.json';

// Valid base manifest for testing
const validTestnetManifest: NetworkManifest = {
  manifestVersion: '1.0.0',
  network: 'testnet',
  networkPassphrase: 'Test SDF Network ; September 2015',
  horizonUrl: 'https://horizon-testnet.stellar.org',
  sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
  contracts: {
    greenPay: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    escrow: 'CA7QONGH2UNE24KFKB5HLQPQXUQNVZXMVNXRK63RK6U2CBHKDAVRB3RU',
    daoGovernance: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  },
  generatedAt: '2026-01-01T00:00:00Z',
};

describe('validateManifest', () => {
  it('accepts a fully valid testnet manifest', () => {
    expect(() => validateManifest(validTestnetManifest)).not.toThrow();
  });

  it('accepts a fully valid mainnet manifest', () => {
    const mainnet: NetworkManifest = {
      ...validTestnetManifest,
      network: 'mainnet',
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
      horizonUrl: 'https://horizon.stellar.org',
      sorobanRpcUrl: 'https://soroban.stellar.org',
    };

    expect(() => validateManifest(mainnet)).not.toThrow();
  });

  it('throws when passphrase does not match network', () => {
    const bad = {
      ...validTestnetManifest,
      // testnet manifest with mainnet passphrase
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
    };

    expect(() => validateManifest(bad)).toThrow(/networkPassphrase mismatch/);
  });

  it('error message names the mismatched field', () => {
    const bad = {
      ...validTestnetManifest,
      networkPassphrase: 'wrong passphrase',
    };

    try {
      validateManifest(bad);
      fail('Expected to throw');
    } catch (e) {
      expect((e as Error).message).toContain('networkPassphrase');
    }
  });

  it('throws when contract ID is not valid Stellar address', () => {
    const bad = {
      ...validTestnetManifest,
      contracts: { 
        greenPay: 'not-a-contract-id',
        escrow: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        daoGovernance: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      },
    };

    expect(() => validateManifest(bad)).toThrow(/not a valid Stellar/);
  });

  it('error names the invalid contract field', () => {
    const bad = {
      ...validTestnetManifest,
      contracts: {
        greenPay: 'INVALID',
        escrow: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        daoGovernance: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      },
    };

    try {
      validateManifest(bad);
      fail('Expected to throw');
    } catch (e) {
      expect((e as Error).message).toContain('contracts.greenPay');
    }
  });

  it('throws when horizonUrl is not a valid URL', () => {
    const bad = { ...validTestnetManifest, horizonUrl: 'not-a-url' };

    expect(() => validateManifest(bad)).toThrow(/horizonUrl/);
  });

  it('throws when sorobanRpcUrl is not a valid URL', () => {
    const bad = { ...validTestnetManifest, sorobanRpcUrl: 'not-a-url' };

    expect(() => validateManifest(bad)).toThrow(/sorobanRpcUrl/);
  });

  it('accepts empty contract IDs (not yet deployed)', () => {
    const manifest: NetworkManifest = {
      ...validTestnetManifest,
      contracts: {
        greenPay: '',
        escrow: '',
        daoGovernance: '',
      },
    };

    expect(() => validateManifest(manifest)).not.toThrow();
  });

  it('rejects partial contract IDs', () => {
    const bad = {
      ...validTestnetManifest,
      contracts: {
        greenPay: 'C123',
        escrow: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        daoGovernance: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      },
    };

    expect(() => validateManifest(bad)).toThrow(/not a valid Stellar/);
  });

  it('rejects contract IDs that are too short', () => {
    const bad = {
      ...validTestnetManifest,
      contracts: {
        greenPay: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYS',
        escrow: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        daoGovernance: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      },
    };

    expect(() => validateManifest(bad)).toThrow(/not a valid Stellar/);
  });

  it('rejects contract IDs that are too long', () => {
    const bad = {
      ...validTestnetManifest,
      contracts: {
        greenPay: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSCX',
        escrow: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        daoGovernance: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      },
    };

    expect(() => validateManifest(bad)).toThrow(/not a valid Stellar/);
  });

  it('rejects contract IDs with invalid characters', () => {
    const bad = {
      ...validTestnetManifest,
      contracts: {
        greenPay: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'.replace('L', '0'),
        escrow: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        daoGovernance: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      },
    };

    expect(() => validateManifest(bad)).toThrow(/not a valid Stellar/);
  });
});

describe('getManifest', () => {
  it('returns testnet manifest for "testnet"', () => {
    const manifest = getManifest('testnet');

    expect(manifest.network).toBe('testnet');
  });

  it('returns mainnet manifest for "mainnet"', () => {
    const manifest = getManifest('mainnet');

    expect(manifest.network).toBe('mainnet');
  });

  it('throws for unknown network with helpful message', () => {
    expect(() => getManifest('unknown')).toThrow(/No manifest found/);
    expect(() => getManifest('unknown')).toThrow(/unknown/);
  });

  it('throws for empty string network', () => {
    expect(() => getManifest('')).toThrow();
  });

  it('validates manifest on load', () => {
    const testnet = getManifest('testnet');

    expect(testnet.networkPassphrase).toBe('Test SDF Network ; September 2015');
    expect(testnet.horizonUrl).toBeTruthy();
    expect(testnet.sorobanRpcUrl).toBeTruthy();
  });
});

describe('network manifests are internally consistent', () => {
  it('testnet manifest passes validation', () => {
    expect(() => validateManifest(testnetManifest as NetworkManifest)).not.toThrow();
  });

  it('mainnet manifest passes validation', () => {
    expect(() => validateManifest(mainnetManifest as NetworkManifest)).not.toThrow();
  });

  it('testnet has correct passphrase', () => {
    expect(testnetManifest.networkPassphrase).toBe('Test SDF Network ; September 2015');
  });

  it('mainnet has correct passphrase', () => {
    expect(mainnetManifest.networkPassphrase).toBe('Public Global Stellar Network ; September 2015');
  });

  it('testnet uses testnet Horizon URL', () => {
    expect(testnetManifest.horizonUrl).toContain('testnet');
  });

  it('mainnet uses mainnet Horizon URL', () => {
    expect(mainnetManifest.horizonUrl).not.toContain('testnet');
    expect(mainnetManifest.horizonUrl).toContain('horizon.stellar.org');
  });

  it('testnet uses testnet Soroban RPC URL', () => {
    expect(testnetManifest.sorobanRpcUrl).toContain('testnet');
  });

  it('mainnet uses mainnet Soroban RPC URL', () => {
    expect(mainnetManifest.sorobanRpcUrl).not.toContain('testnet');
    expect(mainnetManifest.sorobanRpcUrl).toContain('soroban.stellar.org');
  });

  it('each network resolves to fully consistent configuration', () => {
    for (const network of ['testnet', 'mainnet']) {
      const manifest = getManifest(network);

      // All required fields present and truthy
      expect(manifest.networkPassphrase).toBeTruthy();
      expect(manifest.horizonUrl).toBeTruthy();
      expect(manifest.sorobanRpcUrl).toBeTruthy();
      expect(manifest.manifestVersion).toBeTruthy();
      expect(manifest.generatedAt).toBeTruthy();
      expect(manifest.network).toBe(network);
    }
  });
});

describe('getConnectSrcUrls', () => {
  it('returns origin URLs for horizon and rpc', () => {
    const urls = getConnectSrcUrls(validTestnetManifest);

    expect(urls).toContain('https://horizon-testnet.stellar.org');
    expect(urls).toContain('https://soroban-testnet.stellar.org');
  });

  it('returns only origins (no paths)', () => {
    const urls = getConnectSrcUrls(validTestnetManifest);

    urls.forEach((url) => {
      expect(url).not.toContain('/api');
      expect(url).not.toContain('/v1');
    });
  });

  it('mainnet manifest produces different connect-src than testnet', () => {
    const testnetUrls = getConnectSrcUrls(testnetManifest as NetworkManifest);
    const mainnetUrls = getConnectSrcUrls(mainnetManifest as NetworkManifest);

    expect(testnetUrls).not.toEqual(mainnetUrls);
  });

  it('extracts https protocol from URLs', () => {
    const urls = getConnectSrcUrls(validTestnetManifest);

    urls.forEach((url) => {
      expect(url.startsWith('https://')).toBe(true);
    });
  });

  it('deduplicates URLs if needed', () => {
    const manifest: NetworkManifest = {
      ...validTestnetManifest,
      horizonUrl: 'https://horizon-testnet.stellar.org',
      sorobanRpcUrl: 'https://horizon-testnet.stellar.org', // Same origin
    };

    const urls = getConnectSrcUrls(manifest);

    // Should have only 1 unique entry
    expect(urls.length).toBe(1);
    expect(urls[0]).toBe('https://horizon-testnet.stellar.org');
  });

  it('works with mainnet manifest', () => {
    const urls = getConnectSrcUrls(mainnetManifest as NetworkManifest);

    expect(urls).toContain('https://horizon.stellar.org');
    expect(urls).toContain('https://soroban.stellar.org');
    expect(urls.every((url) => !url.includes('testnet'))).toBe(true);
  });
});

describe('manifest schema integrity', () => {
  it('testnet manifest has all required contract fields', () => {
    const manifest = testnetManifest as NetworkManifest;

    expect(manifest.contracts.greenPay).toBeDefined();
    expect(manifest.contracts.escrow).toBeDefined();
    expect(manifest.contracts.daoGovernance).toBeDefined();
  });

  it('mainnet manifest has all required contract fields', () => {
    const manifest = mainnetManifest as NetworkManifest;

    expect(manifest.contracts.greenPay).toBeDefined();
    expect(manifest.contracts.escrow).toBeDefined();
    expect(manifest.contracts.daoGovernance).toBeDefined();
  });

  it('manifest version is semver-compliant', () => {
    const manifest = testnetManifest as NetworkManifest;

    expect(manifest.manifestVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('generatedAt is ISO 8601 timestamp or placeholder', () => {
    const manifest = testnetManifest as NetworkManifest;

    // Either a valid ISO timestamp or the placeholder
    const isValid =
      manifest.generatedAt === 'GENERATED_BY_DEPLOY_WORKFLOW' ||
      !isNaN(new Date(manifest.generatedAt).getTime());

    expect(isValid).toBe(true);
  });
});
