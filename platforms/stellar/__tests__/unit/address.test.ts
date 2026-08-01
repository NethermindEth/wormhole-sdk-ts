import { UniversalAddress } from "@wormhole-foundation/sdk-connect";
import { StrKey } from "@stellar/stellar-sdk";
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

  it("treats the raw 32-byte core emitter as a separate, invertible identity", () => {
    // The Core emitter is the raw contract id (invertible via StrKey), which is
    // deliberately NOT the keccak256 hash_address the platform address produces.
    const raw = StrKey.decodeContract(CONTRACT);
    expect(StrKey.encodeContract(raw)).toBe(CONTRACT);
    expect("0x" + Buffer.from(raw).toString("hex")).not.toBe(CONTRACT_HASH);
  });
});
