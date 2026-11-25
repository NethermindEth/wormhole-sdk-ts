import type { Transaction } from "@stellar/stellar-sdk";
import type { Network, UnsignedTransaction } from "@wormhole-foundation/sdk-connect";
import type { StellarChains } from "./types.js";

/**
 * A prepared (simulated + assembled) Soroban transaction ready to be signed.
 * Soroban requires every invocation to be simulated so the footprint and
 * resource fee are known; the generators do that before yielding, so the signer
 * only has to sign and submit.
 *
 * `transaction.fee` is the whole fee in stroops, resource fee included. It is the fee a wallet
 * shows, and the fee a `StellarSigner` caps with `maxFee`.
 */
export class StellarUnsignedTransaction<N extends Network, C extends StellarChains>
  implements UnsignedTransaction<N, C>
{
  constructor(
    readonly transaction: Transaction,
    readonly network: N,
    readonly chain: C,
    readonly description: string,
    readonly parallelizable: boolean = false,
  ) {}
}
