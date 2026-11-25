import type {
  Chain,
  ChainsConfig,
  Network,
  SignedTx,
  StaticPlatformMethods,
  TokenId,
  TxHash,
} from "@wormhole-foundation/sdk-connect";
import {
  PlatformContext,
  Wormhole,
  chainToPlatform,
  decimals as nativeDecimals,
  isNative,
  nativeChainIds,
  networkPlatformConfigs,
} from "@wormhole-foundation/sdk-connect";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  StrKey,
  TransactionBuilder,
  extractBaseAddress,
  rpc as SorobanRpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { FeeBumpTransaction, Transaction } from "@stellar/stellar-sdk";
import { StellarAddress } from "./address.js";
import { StellarChain } from "./chain.js";
import { nativeSacId, stellarNetworkPassphrase } from "./constants.js";
import type { AnyStellarAddress, StellarChains, StellarPlatformType } from "./types.js";
import { _platform } from "./types.js";

// A throwaway source account for read-only simulations; it never signs or submits.
const READ_ONLY_SOURCE = StrKey.encodeEd25519PublicKey(Buffer.alloc(32));

// Each RPC client's answer to getNetwork. A client cannot change networks, so an answer holds for
// the client's life; a rejected one is dropped so that the next call asks again.
const rpcNetworks = new WeakMap<SorobanRpc.Server, Promise<SorobanRpc.Api.GetNetworkResponse>>();

// How long sendAndConfirm keeps polling after a transaction's time bound, or after the send when
// that is later, so the RPC can ingest the first ledger that closes past the bound.
const OUTCOME_MARGIN_MS = 60_000;

/**
 * Thrown when a submitted transaction may have landed or may still land, so it is reported
 * neither as succeeded nor as failed.
 *
 * Look the transaction up by its hash before building a replacement, or the replacement may pay
 * twice. `cause` holds the send's error answer or the first RPC error, if there was one.
 */
export class StellarTxOutcomeUnknownError extends Error {
  constructor(
    /** The transaction's hash; for a fee bump, its inner transaction's hash. */
    readonly hash: TxHash,
    /** The transaction's time bound, in Unix seconds; 0 when it has none. */
    readonly maxTime: number,
    options?: ErrorOptions,
  ) {
    super(`Stellar tx ${hash}: outcome unknown, time bound ${maxTime}`, options);
    this.name = "StellarTxOutcomeUnknownError";
  }
}

export class StellarPlatform<N extends Network>
  extends PlatformContext<N, StellarPlatformType>
  implements StaticPlatformMethods<StellarPlatformType, typeof StellarPlatform>
{
  static _platform = _platform;

  constructor(network: N, config?: ChainsConfig<N, StellarPlatformType>) {
    super(network, config ?? networkPlatformConfigs(network, StellarPlatform._platform));
  }

  getRpc<C extends StellarChains>(chain: C): SorobanRpc.Server {
    const config = this.config[chain];
    if (!config) throw new Error("No configuration available for chain: " + chain);
    return new SorobanRpc.Server(config.rpc, { allowHttp: config.rpc.startsWith("http:") });
  }

  getChain<C extends StellarChains>(chain: C, rpc?: SorobanRpc.Server): StellarChain<N, C> {
    if (chain in this.config) return new StellarChain<N, C>(chain, this, rpc);
    throw new Error("No configuration available for chain: " + chain);
  }

  static isSupportedChain(chain: Chain): boolean {
    return chainToPlatform(chain) === StellarPlatform._platform;
  }

  static nativeTokenId<N extends Network, C extends StellarChains>(
    network: N,
    chain: C,
  ): TokenId<C> {
    if (!StellarPlatform.isSupportedChain(chain))
      throw new Error(`invalid chain for ${_platform}: ${chain}`);
    return Wormhole.tokenId(chain, nativeSacId(network));
  }

  static isNativeTokenId<N extends Network, C extends StellarChains>(
    network: N,
    chain: C,
    tokenId: TokenId,
  ): boolean {
    if (!StellarPlatform.isSupportedChain(chain)) return false;
    if (tokenId.chain !== chain) return false;
    return tokenId.address.toString() === nativeSacId(network);
  }

  static async getDecimals(
    network: Network,
    _chain: Chain,
    rpc: SorobanRpc.Server,
    token: AnyStellarAddress,
  ): Promise<number> {
    if (isNative(token)) return nativeDecimals.nativeDecimals(StellarPlatform._platform);
    const contractId = new StellarAddress(token).toString();
    return Number(await StellarPlatform.simulateRead(rpc, network, contractId, "decimals"));
  }

  static async getBalance(
    network: Network,
    _chain: Chain,
    rpc: SorobanRpc.Server,
    walletAddr: string,
    token: AnyStellarAddress,
  ): Promise<bigint | null> {
    const contractId = isNative(token)
      ? nativeSacId(network)
      : new StellarAddress(token).toString();
    const balance = await StellarPlatform.simulateRead(
      rpc,
      network,
      contractId,
      "balance",
      new Address(walletAddr).toScVal(),
    );
    return balance as bigint;
  }

  static async getLatestBlock(rpc: SorobanRpc.Server): Promise<number> {
    const { sequence } = await rpc.getLatestLedger();
    return sequence;
  }

  // Stellar ledgers are final on close (SCP), so finalized == latest.
  static async getLatestFinalizedBlock(rpc: SorobanRpc.Server): Promise<number> {
    return StellarPlatform.getLatestBlock(rpc);
  }

  static async sendWait(
    _chain: Chain,
    rpc: SorobanRpc.Server,
    stxns: SignedTx[],
  ): Promise<TxHash[]> {
    const { passphrase } = await rpc.getNetwork();
    const txhashes: TxHash[] = [];
    for (const stxn of stxns)
      txhashes.push(
        await StellarPlatform.sendAndConfirm(
          rpc,
          TransactionBuilder.fromXDR(stxn as string, passphrase),
        ),
      );
    return txhashes;
  }

  // Submit a signed transaction and wait for its result, returning the hash of the envelope
  // that landed. The tx is tracked by its locally computed hash; a fee bump by its inner tx's,
  // which stays the same when another fee bump of that tx lands instead.
  //
  // The tx is reported failed only when the RPC rejects it for good, it fails on chain, or its
  // time bound has passed while the source account's sequence is still below the tx's. Any
  // other ending throws StellarTxOutcomeUnknownError, because the tx may have landed or may
  // still land. A tx with no upper time bound can always still land, so it never reaches the
  // sequence rule.
  static async sendAndConfirm(
    rpc: SorobanRpc.Server,
    tx: Transaction | FeeBumpTransaction,
  ): Promise<TxHash> {
    const inner = "innerTransaction" in tx ? tx.innerTransaction : tx;
    const hash = inner.hash().toString("hex");
    const maxTime = Number(inner.timeBounds?.maxTime ?? 0);
    // The send's error answer or the first RPC error, kept for the expired and outcome-unknown
    // errors.
    let cause: unknown;
    const attempt = <T>(call: Promise<T>) =>
      call.catch((e: unknown) => {
        cause ??= e;
        return undefined;
      });

    const sent = await attempt(rpc.sendTransaction(tx));
    if (sent?.status === "ERROR") {
      // A failed fee bump is named by its inner tx's result code.
      const error = sent.errorResult;
      const outer = error?.result();
      const code = (
        outer?.switch().name === "txFeeBumpInnerFailed"
          ? outer.innerResultPair().result().result()
          : outer
      )?.switch().name;
      const detail = error ? ` ${code} (${error.toXDR("base64")})` : "";
      // These also answer a resend of a tx that already landed: txBAD_SEQ before its time
      // bound, txTOO_LATE after it, and txINSUFFICIENT_FEE when the queue is too full for its
      // fee or the resend is a fee bump too small to replace a queued tx. Checks made before
      // the sequence, such as a fee bump's fee source balance, can reject such a resend too, so
      // any other error is looked up once before the tx is called failed.
      const mayLand = code === "txBadSeq" || code === "txTooLate" || code === "txInsufficientFee";
      if (!mayLand && (await attempt(rpc.getTransaction(hash)))?.status !== "SUCCESS")
        throw new Error(`Failed to send Stellar tx ${hash}: ${sent.status}${detail}`);
      cause = new Error(`Send answered ${sent.status}${detail}`);
    }

    const account = xdr.LedgerKey.account(
      new xdr.LedgerKeyAccount({
        accountId: Keypair.fromPublicKey(extractBaseAddress(inner.source)).xdrPublicKey(),
      }),
    );
    const limit = Math.max(maxTime * 1000, Date.now()) + OUTCOME_MARGIN_MS;
    // The first ledger seen closing past the time bound. Close times only grow, so no ledger
    // from this one on can include the tx.
    let boundLedger: number | undefined;
    do {
      const got = await attempt(rpc.getTransaction(hash));
      // The rpc client may use another copy of stellar-sdk, whose XDR enums fail this copy's
      // identity checks, so the envelope is parsed again from its bytes.
      if (got?.status === "SUCCESS")
        return TransactionBuilder.fromXDR(got.envelopeXdr.toXDR("base64"), inner.networkPassphrase)
          .hash()
          .toString("hex");
      if (got?.status === "FAILED") throw new Error(`Stellar tx ${hash} failed: ${got.status}`);
      const closeTime = String(got?.latestLedgerCloseTime);
      if (got && maxTime && /^\d+$/.test(closeTime) && Number(closeTime) > maxTime)
        boundLedger ??= got.latestLedger;
      if (boundLedger !== undefined) {
        const read = await attempt(rpc.getLedgerEntries(account));
        // A replica behind boundLedger may not show the sequence the tx consumed.
        if (read && read.latestLedger >= boundLedger) {
          const seq = read.entries[0]?.val.account().seqNum().toString();
          if (seq !== undefined && BigInt(seq) < BigInt(inner.sequence))
            throw new Error(`Stellar tx ${hash} failed: expired at time bound ${maxTime}`, {
              cause,
            });
          throw new StellarTxOutcomeUnknownError(hash, maxTime, { cause });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } while (Date.now() < limit);
    throw new StellarTxOutcomeUnknownError(hash, maxTime, { cause });
  }

  static chainFromChainId(chainId: string): [Network, StellarChains] {
    return nativeChainIds.platformNativeChainIdToNetworkChain(StellarPlatform._platform, chainId);
  }

  static async chainFromRpc(rpc: SorobanRpc.Server): Promise<[Network, StellarChains]> {
    let answer = rpcNetworks.get(rpc);
    if (!answer) {
      answer = rpc.getNetwork();
      rpcNetworks.set(rpc, answer);
      answer.catch(() => rpcNetworks.delete(rpc));
    }
    const { passphrase } = await answer;
    return StellarPlatform.chainFromChainId(passphrase);
  }

  // Build and simulate a read-only contract call, returning its decoded result.
  static async simulateRead(
    rpc: SorobanRpc.Server,
    network: Network,
    contractId: string,
    method: string,
    ...args: xdr.ScVal[]
  ): Promise<unknown> {
    const tx = new TransactionBuilder(new Account(READ_ONLY_SOURCE, "0"), {
      fee: BASE_FEE,
      networkPassphrase: stellarNetworkPassphrase(network),
    })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(30)
      .build();
    const sim = await rpc.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(sim))
      throw new Error(`Simulation failed for ${method}: ${sim.error}`);
    return scValToNative(sim.result!.retval);
  }
}
