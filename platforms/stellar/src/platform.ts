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
  StrKey,
  TransactionBuilder,
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

  // Submit a signed transaction and wait for its result, returning the tx hash.
  static async sendAndConfirm(
    rpc: SorobanRpc.Server,
    tx: Transaction | FeeBumpTransaction,
  ): Promise<TxHash> {
    const sent = await rpc.sendTransaction(tx);
    if (sent.status !== "PENDING") throw new Error(`Failed to send Stellar tx: ${sent.status}`);
    const result = await rpc.pollTransaction(sent.hash);
    if (result.status !== "SUCCESS")
      throw new Error(`Stellar tx ${sent.hash} failed: ${result.status}`);
    return sent.hash;
  }

  static chainFromChainId(chainId: string): [Network, StellarChains] {
    return nativeChainIds.platformNativeChainIdToNetworkChain(StellarPlatform._platform, chainId);
  }

  static async chainFromRpc(rpc: SorobanRpc.Server): Promise<[Network, StellarChains]> {
    const { passphrase } = await rpc.getNetwork();
    return StellarPlatform.chainFromChainId(passphrase);
  }

  // Build and simulate a read-only contract call, returning its decoded result.
  private static async simulateRead(
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
