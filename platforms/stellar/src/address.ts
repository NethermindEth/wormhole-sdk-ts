import { Address, UniversalAddress, registerNative } from "@wormhole-foundation/sdk-connect";
import { StrKey } from "@stellar/stellar-sdk";
import { _platform } from "./types.js";
import type { AnyStellarAddress } from "./types.js";

/**
 * A Stellar address is a StrKey-encoded contract (`C…`) or account (`G…`).
 *
 * `toUniversalAddress()` is the one-way `hash_address = keccak256(strkey_text)`
 * the Soroban contracts use as an on-chain identity (the NTT `sender`,
 * `source_token`, `to` and peer fields). Because that hash cannot be inverted,
 * the constructor never accepts a `UniversalAddress` and `toNative()` returns
 * `this`; a typed `C…`/`G…` is recovered from a hash only via the async on-chain
 * `get_address_from_hash` registry, which lives in the NTT layer. The raw
 * 32-byte core emitter is a separate representation handled by the Core parse
 * path (`StrKey.encodeContract`), never through this type.
 */
export class StellarAddress implements Address {
  static readonly platform = _platform;
  readonly type: string = "Native";

  readonly address: string;

  constructor(address: AnyStellarAddress) {
    if (StellarAddress.instanceof(address)) {
      this.address = address.address;
    } else if (typeof address === "string" && StellarAddress.isValidAddress(address)) {
      this.address = address;
    } else {
      throw new Error(`Invalid Stellar address: ${address}`);
    }
  }

  unwrap(): string {
    return this.address;
  }

  toString(): string {
    return this.address;
  }

  toNative(): StellarAddress {
    return this;
  }

  // The bytes of the StrKey text — i.e. the preimage `toUniversalAddress()`
  // hashes — not the decoded raw id (that is the separate Core-emitter form).
  toUint8Array(): Uint8Array {
    return new Uint8Array(Buffer.from(this.address));
  }

  toUniversalAddress(): UniversalAddress {
    return new UniversalAddress(this.address, "keccak256");
  }

  /** A contract (`C…`) or account (`G…`) StrKey; muxed `M…` accounts are rejected. */
  static isValidAddress(address: string): boolean {
    return StrKey.isValidContract(address) || StrKey.isValidEd25519PublicKey(address);
  }

  static instanceof(address: any): address is StellarAddress {
    return address?.constructor?.platform === StellarAddress.platform;
  }

  equals(other: StellarAddress | UniversalAddress): boolean {
    return StellarAddress.instanceof(other)
      ? other.address === this.address
      : other.equals(this.toUniversalAddress());
  }
}

declare module "@wormhole-foundation/sdk-connect" {
  export namespace WormholeRegistry {
    interface PlatformToNativeAddressMapping {
      Stellar: StellarAddress;
    }
  }
}

registerNative(_platform, StellarAddress);
