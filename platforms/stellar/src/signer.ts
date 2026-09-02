import { Keypair, rpc as SorobanRpc } from "@stellar/stellar-sdk";
import type {
  Network,
  SignAndSendSigner,
  TxHash,
  UnsignedTransaction,
} from "@wormhole-foundation/sdk-connect";
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
  constructor(
    private _chain: C,
    private _rpc: SorobanRpc.Server,
    private _keypair: Keypair,
  ) {}

  chain(): C {
    return this._chain;
  }

  address(): string {
    return this._keypair.publicKey();
  }

  async signAndSend(txs: UnsignedTransaction<N, C>[]): Promise<TxHash[]> {
    const txhashes: TxHash[] = [];
    for (const utx of txs) {
      const { transaction } = utx as StellarUnsignedTransaction<N, C>;
      // The generators yield an already-prepared (simulated + assembled) tx, so
      // signing the envelope covers source-account authorization.
      // minimal-ts: signing non-source Soroban auth entries (authorizeEntry)
      // lands with the NTT layer — the first caller that authorizes an address
      // other than the transaction source.
      transaction.sign(this._keypair);
      txhashes.push(await StellarPlatform.sendAndConfirm(this._rpc, transaction));
    }
    return txhashes;
  }
}
