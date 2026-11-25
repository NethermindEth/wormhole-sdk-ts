import { Keypair, rpc as SorobanRpc } from "@stellar/stellar-sdk";
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

export async function getStellarSigner(
  rpc: SorobanRpc.Server,
  secretKey: string,
): Promise<SignAndSendSigner<Network, StellarChains>> {
  const [, chain] = await StellarPlatform.chainFromRpc(rpc);
  return new StellarSigner(chain, rpc, Keypair.fromSecret(secretKey));
}

export class StellarSigner<N extends Network, C extends StellarChains>
  implements SignAndSendSigner<N, C>
{
  readonly #keypair: Keypair;

  constructor(
    private _chain: C,
    private _rpc: SorobanRpc.Server,
    keypair: Keypair,
  ) {
    this.#keypair = keypair;
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
      return transaction;
    });

    const txhashes: TxHash[] = [];
    for (const transaction of transactions) {
      // The generators yield an already-prepared (simulated + assembled) tx, so
      // signing the envelope covers source-account authorization.
      // minimal-ts: signing non-source Soroban auth entries (authorizeEntry)
      // lands with the NTT layer — the first caller that authorizes an address
      // other than the transaction source.
      transaction.sign(this.#keypair);
      txhashes.push(await StellarPlatform.sendAndConfirm(this._rpc, transaction));
    }
    return txhashes;
  }
}
