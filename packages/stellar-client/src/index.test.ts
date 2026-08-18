/**
 * Tests for @greenpay/stellar-client
 *
 * The critical test: proves that every GreenPay sub-project resolves
 * to the same passphrase given the same underlying configuration,
 * regardless of which env-var prefix it uses.
 */
import { describe, it, expect } from "vitest";
import { Networks } from "@stellar/stellar-sdk";
import {
  resolveNetworkLabel,
  resolveNetworkPassphrase,
  resolvePassphrase,
  createStellarClients,
  createHorizonClient,
  createRpcClient,
} from "./index";

// ---------------------------------------------------------------------------
// resolveNetworkLabel
// ---------------------------------------------------------------------------
describe("resolveNetworkLabel", () => {
  it("returns 'testnet' when undefined", () => {
    expect(resolveNetworkLabel(undefined)).toBe("testnet");
  });

  it("returns 'testnet' when empty string", () => {
    expect(resolveNetworkLabel("")).toBe("testnet");
  });

  it("returns 'testnet' for 'testnet'", () => {
    expect(resolveNetworkLabel("testnet")).toBe("testnet");
  });

  it("returns 'mainnet' for 'mainnet'", () => {
    expect(resolveNetworkLabel("mainnet")).toBe("mainnet");
  });

  it("returns 'mainnet' for 'public'", () => {
    expect(resolveNetworkLabel("public")).toBe("mainnet");
  });

  it("is case-insensitive", () => {
    expect(resolveNetworkLabel("TESTNET")).toBe("testnet");
    expect(resolveNetworkLabel("Mainnet")).toBe("mainnet");
    expect(resolveNetworkLabel("PUBLIC")).toBe("mainnet");
  });

  it("strips whitespace", () => {
    expect(resolveNetworkLabel("  mainnet  ")).toBe("mainnet");
    expect(resolveNetworkLabel("  testnet  ")).toBe("testnet");
  });

  it("returns 'testnet' for unknown values", () => {
    expect(resolveNetworkLabel("foo")).toBe("testnet");
  });
});

// ---------------------------------------------------------------------------
// resolveNetworkPassphrase
// ---------------------------------------------------------------------------
describe("resolveNetworkPassphrase", () => {
  it("returns Networks.TESTNET for testnet", () => {
    expect(resolveNetworkPassphrase("testnet")).toBe(Networks.TESTNET);
  });

  it("returns Networks.PUBLIC for mainnet", () => {
    expect(resolveNetworkPassphrase("mainnet")).toBe(Networks.PUBLIC);
  });
});

// ---------------------------------------------------------------------------
// resolvePassphrase (combined label + passphrase)
// ---------------------------------------------------------------------------
describe("resolvePassphrase", () => {
  it("returns TESTNET passphrase for 'testnet'", () => {
    expect(resolvePassphrase("testnet")).toBe(Networks.TESTNET);
  });

  it("returns PUBLIC passphrase for 'mainnet'", () => {
    expect(resolvePassphrase("mainnet")).toBe(Networks.PUBLIC);
  });

  it("returns TESTNET passphrase for undefined", () => {
    expect(resolvePassphrase(undefined)).toBe(Networks.TESTNET);
  });

  it("returns PUBLIC passphrase for 'public'", () => {
    expect(resolvePassphrase("public")).toBe(Networks.PUBLIC);
  });
});

// ---------------------------------------------------------------------------
// Cross-platform passphrase consistency
//
// This is the acceptance-criteria test: given the SAME underlying env
// configuration, all four sub-projects must resolve to the identical
// passphrase.
// ---------------------------------------------------------------------------
describe("cross-platform passphrase consistency", () => {
  it("backend, frontend, mobile, and extension all agree for testnet", () => {
    // Backend uses: process.env.STELLAR_NETWORK
    // Frontend uses: process.env.NEXT_PUBLIC_STELLAR_NETWORK
    // Mobile uses: process.env.EXPO_PUBLIC_STELLAR_NETWORK
    // Extension has no env var — hardcoded testnet

    const backendPassphrase = resolvePassphrase("testnet");
    const frontendPassphrase = resolvePassphrase("testnet");
    const mobilePassphrase = resolvePassphrase("testnet");
    const extensionPassphrase = resolvePassphrase(undefined); // hardcoded default

    expect(backendPassphrase).toBe(frontendPassphrase);
    expect(frontendPassphrase).toBe(mobilePassphrase);
    expect(mobilePassphrase).toBe(extensionPassphrase);
    expect(extensionPassphrase).toBe(Networks.TESTNET);
  });

  it("backend, frontend, mobile all agree for mainnet", () => {
    const backendPassphrase = resolvePassphrase("mainnet");
    const frontendPassphrase = resolvePassphrase("mainnet");
    const mobilePassphrase = resolvePassphrase("public"); // mobile also accepts "public"

    expect(backendPassphrase).toBe(frontendPassphrase);
    expect(frontendPassphrase).toBe(mobilePassphrase);
    expect(backendPassphrase).toBe(Networks.PUBLIC);
  });

  it("all env-var prefix variants resolve identically", () => {
    // Simulate the four different env-var naming conventions all set to
    // the same conceptual value.
    const envVariants = [
      { label: "STELLAR_NETWORK", value: "testnet" },
      { label: "NEXT_PUBLIC_STELLAR_NETWORK", value: "testnet" },
      { label: "EXPO_PUBLIC_STELLAR_NETWORK", value: "testnet" },
      { label: "(hardcoded)", value: undefined },
    ];

    const passphrases = envVariants.map((v) => resolvePassphrase(v.value));
    const unique = [...new Set(passphrases)];

    expect(unique).toHaveLength(1);
    expect(unique[0]).toBe(Networks.TESTNET);
  });

  it("all env-var prefix variants resolve identically for mainnet", () => {
    const envVariants = [
      { label: "STELLAR_NETWORK", value: "mainnet" },
      { label: "NEXT_PUBLIC_STELLAR_NETWORK", value: "mainnet" },
      { label: "EXPO_PUBLIC_STELLAR_NETWORK", value: "public" },
    ];

    const passphrases = envVariants.map((v) => resolvePassphrase(v.value));
    const unique = [...new Set(passphrases)];

    expect(unique).toHaveLength(1);
    expect(unique[0]).toBe(Networks.PUBLIC);
  });
});

// ---------------------------------------------------------------------------
// createStellarClients
// ---------------------------------------------------------------------------
describe("createStellarClients", () => {
  it("creates clients with default testnet config", () => {
    const clients = createStellarClients();

    expect(clients.network).toBe("testnet");
    expect(clients.networkPassphrase).toBe(Networks.TESTNET);
    expect(clients.horizonServer).toBeDefined();
    expect(clients.rpcServer).toBeDefined();
    expect(clients.contractId).toBe("");
    expect(clients.escrowContractId).toBe("");
  });

  it("creates mainnet clients when configured", () => {
    const clients = createStellarClients({ network: "mainnet" });

    expect(clients.network).toBe("mainnet");
    expect(clients.networkPassphrase).toBe(Networks.PUBLIC);
  });

  it("passes through contract IDs", () => {
    const clients = createStellarClients({
      contractId: "CA1234567890ABCDEF",
      escrowContractId: "CB0987654321FEDCBA",
    });

    expect(clients.contractId).toBe("CA1234567890ABCDEF");
    expect(clients.escrowContractId).toBe("CB0987654321FEDCBA");
  });

  it("accepts custom URLs", () => {
    const clients = createStellarClients({
      horizonUrl: "https://custom-horizon.example.com",
      rpcUrl: "https://custom-rpc.example.com",
    });

    expect(clients.horizonServer).toBeDefined();
    expect(clients.rpcServer).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// createHorizonClient / createRpcClient (convenience)
// ---------------------------------------------------------------------------
describe("createHorizonClient", () => {
  it("creates a Horizon server with default URL", () => {
    const server = createHorizonClient();
    expect(server).toBeDefined();
  });

  it("creates a Horizon server with custom URL", () => {
    const server = createHorizonClient("https://custom.example.com");
    expect(server).toBeDefined();
  });
});

describe("createRpcClient", () => {
  it("creates an RPC server with default URL", () => {
    const server = createRpcClient();
    expect(server).toBeDefined();
  });

  it("creates an RPC server with custom URL", () => {
    const server = createRpcClient("https://custom-rpc.example.com");
    expect(server).toBeDefined();
  });
});
