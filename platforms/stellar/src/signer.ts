import { Keypair, extractBaseAddress, rpc as SorobanRpc } from "@stellar/stellar-sdk";
import type {
  Network,
  SignAndSendSigner,
  TxHash,
  UnsignedTransaction,
} from "@wormhole-foundation/sdk-connect";
import { stellarNetworkPassphrase } from "./constants.js";
import { StellarPlatform } from "./platform.js";
import type { StellarChains } from "./types.js";
import type { StellarUnsignedTransaction } from "./unsignedTransaction.js";

/** Options for a {@link StellarSigner}. */
export type StellarSignerOptions = {
  /**
   * The highest fee the signer signs, in stroops. It caps the whole fee, resource fee included.
   * Default: 50_000_000 (5 XLM).
   */
  maxFee?: bigint;
};

/**
 * Creates a signer that signs with `secretKey` and submits through `rpc`.
 *
 * The signer refuses a transaction for another network than `rpc` serves, whose transaction or
 * operation source is another account, with no upper time bound, with a fee above `maxFee`, or
 * that holds anything but one `invokeHostFunction` operation. Sign a `restoreFootprint` or
 * `extendFootprintTtl` transaction with stellar-sdk directly.
 */
export async function getStellarSigner(
  rpc: SorobanRpc.Server,
  secretKey: string,
  opts?: StellarSignerOptions,
): Promise<SignAndSendSigner<Network, StellarChains>> {
  const [, chain] = await StellarPlatform.chainFromRpc(rpc);
  return new StellarSigner(chain, rpc, Keypair.fromSecret(secretKey), opts);
}

export class StellarSigner<N extends Network, C extends StellarChains>
  implements SignAndSendSigner<N, C>
{
  readonly #keypair: Keypair;
  private _maxFee: bigint;

  constructor(
    private _chain: C,
    private _rpc: SorobanRpc.Server,
    keypair: Keypair,
    opts?: StellarSignerOptions,
  ) {
    this.#keypair = keypair;
    this._maxFee = opts?.maxFee ?? 50_000_000n;
  }

  chain(): C {
    return this._chain;
  }

  address(): string {
    return this.#keypair.publicKey();
  }

  /**
   * Returns the public key, which `JSON.stringify` prints for the signer. The keypair sits in a
   * private field, so neither JSON nor `util.inspect` shows the secret key.
   */
  toJSON(): string {
    return this.address();
  }

  async signAndSend(txs: UnsignedTransaction<N, C>[]): Promise<TxHash[]> {
    const [network] = await StellarPlatform.chainFromRpc(this._rpc);
    // Every transaction is checked before the first is signed, so a refused one never leaves the
    // call half sent.
    const transactions = txs.map((utx) => {
      const { transaction } = utx as StellarUnsignedTransaction<N, C>;
      const refuse = (reason: string): never => {
        throw new Error(`StellarSigner refused ${utx.description}: ${reason}`);
      };
      if (utx.chain !== this._chain) refuse(`chain ${utx.chain} is not ${this._chain}`);
      if (utx.network !== network) refuse(`network ${utx.network} is not the RPC's ${network}`);
      const passphrase = stellarNetworkPassphrase(utx.network);
      if (transaction.networkPassphrase !== passphrase)
        refuse(
          `passphrase "${transaction.networkPassphrase}" is not ${utx.network}'s "${passphrase}"`,
        );
      const source = extractBaseAddress(transaction.source);
      if (source !== this.address()) refuse(`source ${source} is not ${this.address()}`);
      // An operation's own source is the account its source-account auth entries authorize.
      const opSource = transaction.operations[0]?.source;
      if (opSource && extractBaseAddress(opSource) !== this.address())
        refuse(`operation source ${opSource} is not ${this.address()}`);
      if (!Number(transaction.timeBounds?.maxTime)) refuse("it has no upper time bound");
      const ops = transaction.operations.map((op) => op.type).join(", ");
      if (ops !== "invokeHostFunction") refuse(`operations ${ops} are not one invokeHostFunction`);
      if (BigInt(transaction.fee) > this._maxFee)
        refuse(`fee ${transaction.fee} is above maxFee (${this._maxFee})`);
      return transaction;
    });

    const txhashes: TxHash[] = [];
    for (const transaction of transactions) {
      // The signer signs only the envelope, which authorizes the source account's auth entries
      // and no other address's.
      transaction.sign(this.#keypair);
      txhashes.push(await StellarPlatform.sendAndConfirm(this._rpc, transaction));
    }
    return txhashes;
  }
}
