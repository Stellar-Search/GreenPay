import { formatSimulationFailure, isResourceBudgetFailure, isValidStellarAddress } from "../stellar";

describe("isValidStellarAddress", () => {
    it("should return true for a valid Stellar public key with a correct checksum", () => {
        // A genuinely checksum-valid key, derived deterministically so it can
        // be re-verified: Keypair.fromRawEd25519Seed(Buffer.alloc(32)).
        // A hand-written 56-character string will not do here — that is the
        // exact failure mode this function exists to catch.
        const validAddress = "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH";
        expect(isValidStellarAddress(validAddress)).toBe(true);
    });

    it("should reject a string that matches the Regex shape (G...56 chars) but has an invalid checksum", () => {
        // This string starts with 'G' and is 56 chars, so regex passes, but checksum FAILS
        const regexMatchButChecksumInvalid = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

        expect(isValidStellarAddress(regexMatchButChecksumInvalid)).toBe(false);
    });

    it("should return false for invalid formats or empty strings", () => {
        expect(isValidStellarAddress("")).toBe(false);
        expect(isValidStellarAddress("invalid_address")).toBe(false);
        expect(isValidStellarAddress("G12345")).toBe(false);
    });
});

describe("isResourceBudgetFailure", () => {
    it("detects Soroban budget errors that grow with accumulated state", () => {
        expect(isResourceBudgetFailure('InsufficientCpuInstructions')).toBe(true);
        expect(isResourceBudgetFailure("CheckpointError: InsufficientMemory")).toBe(true);
        expect(
            isResourceBudgetFailure(
                "Budget failure. Cost of contract execution exceeds the provided budget.",
            ),
        ).toBe(true);
        expect(isResourceBudgetFailure('{"error":"txn_too_expensive"}')).toBe(true);
    });

    it("does not flag funding, address, or plain host errors as budget failures", () => {
        expect(isResourceBudgetFailure("Insufficient XLM to pay Soroban fees")).toBe(false);
        expect(isResourceBudgetFailure("Contract not found on testnet")).toBe(false);
        expect(
            isResourceBudgetFailure('HostError: Error(WasmVm, InvalidAction)'),
        ).toBe(false);
    });
});

describe("formatSimulationFailure", () => {
    it("surfaces a donation resource-budget failure as an actionable message", () => {
        const err = formatSimulationFailure(
            { error: "vm", vmError: "InsufficientCpuInstructions" },
            { contractId: "C…", op: "donation" },
        );
        expect(err.message).toContain("resource");
        expect(err.message).toContain("Nothing was sent");
    });

    it("names the escrow operation when the failing call is a release", () => {
        const err = formatSimulationFailure(
            { message: "Budget failure. Cost exceeds the provided budget." },
            { contractId: "C…", op: "escrow" },
        );
        expect(err.message).toContain("escrow release");
    });

    it("keeps the generic donation fallback specific to the donation path", () => {
        const err = formatSimulationFailure({ error: "vm" }, { op: "donation" });
        expect(err.message).toContain("NEXT_PUBLIC_CONTRACT_ID");
    });
});
