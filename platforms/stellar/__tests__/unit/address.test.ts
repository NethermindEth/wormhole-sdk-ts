import { UniversalAddress } from "@wormhole-foundation/sdk-connect";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { StellarAddress } from "../../src/address.js";

// A contract (native XLM SAC, testnet) and the all-zero account, with their
// hash_address = keccak256(strkey_text) — the identity every NTT message carries
// on the wire. Vectors pin the Rust `stellar_addr_to_hash` primitive so any drift
// in the shared keccak256-of-the-StrKey-text behaviour fails loudly here.
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const CONTRACT_HASH = "0xd4e65a4d53b8465b30e7dd31ce1a8ed13d10c5b2791c570ccb6a126a04444c37";
const ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const ACCOUNT_HASH = "0xf355bd88c1a5f8cc4b12dc1ee8345241aaa9922ac54fddb22cc485f28e8d0e8e";
const MUXED = "MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFNZG";
const SEED = Keypair.random().secret();

// The message of the error that constructing a StellarAddress from `input` throws.
const errorFor = (input: string | Uint8Array) => {
  try {
    new StellarAddress(input);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error(`${input} was accepted`);
};

describe("StellarAddress", () => {
  it("hashes C… and G… to their keccak256 hash_address", () => {
    expect(new StellarAddress(CONTRACT).toUniversalAddress().toString()).toBe(CONTRACT_HASH);
    expect(new StellarAddress(ACCOUNT).toUniversalAddress().toString()).toBe(ACCOUNT_HASH);
  });

  it("cannot be constructed from a UniversalAddress (the hash is one-way)", () => {
    expect(() => new StellarAddress(new UniversalAddress(CONTRACT_HASH))).toThrow();
  });

  it("accepts C…/G…, rejects muxed M… and non-addresses", () => {
    expect(StellarAddress.isValidAddress(CONTRACT)).toBe(true);
    expect(StellarAddress.isValidAddress(ACCOUNT)).toBe(true);
    expect(StellarAddress.isValidAddress(MUXED)).toBe(false);
    expect(() => new StellarAddress("not-an-address")).toThrow();
  });

  it("validates the address it copies from another Stellar address", () => {
    class Impostor {
      static readonly platform = "Stellar";
      readonly address = "not-an-address";
    }
    expect(() => new StellarAddress(new Impostor() as any)).toThrow(
      "Invalid Stellar address: not-an-address",
    );
    expect(new StellarAddress(new StellarAddress(CONTRACT)).address).toBe(CONTRACT);
  });

  it("rejects an account with a bad checksum and a muxed account", () => {
    const badChecksum = ACCOUNT.slice(0, -1) + (ACCOUNT.endsWith("A") ? "B" : "A");
    expect(() => new StellarAddress(badChecksum)).toThrow(
      `Invalid Stellar address: ${badChecksum}`,
    );
    expect(() => new StellarAddress(MUXED)).toThrow(`Invalid Stellar address: ${MUXED}`);
  });

  it.each([
    ["a secret seed", SEED],
    ["a quoted secret seed after a space", ` "${SEED}"`],
    ["a secret seed in a Buffer", Buffer.from(SEED)],
  ])("keeps %s out of its error", (_, input) => {
    expect(errorFor(input)).not.toContain(SEED);
  });

  it("keeps a mistyped secret seed out of its error", () => {
    const mistyped = SEED.slice(0, -1) + (SEED.endsWith("A") ? "B" : "A");
    const message = errorFor(mistyped);
    for (let i = 0; i + 20 <= mistyped.length; i++)
      expect(message).not.toContain(mistyped.slice(i, i + 20));
  });

  it("names an invalid input that does not start with S", () => {
    expect(errorFor("not-an-address")).toBe("Invalid Stellar address: not-an-address");
  });

  it("treats the raw 32-byte core emitter as a separate, invertible identity", () => {
    // The Core emitter is the raw contract id (invertible via StrKey), which is
    // deliberately NOT the keccak256 hash_address the platform address produces.
    const raw = StrKey.decodeContract(CONTRACT);
    expect(StrKey.encodeContract(raw)).toBe(CONTRACT);
    expect("0x" + Buffer.from(raw).toString("hex")).not.toBe(CONTRACT_HASH);
  });
});
