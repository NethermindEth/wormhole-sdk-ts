import type { rpc as SorobanRpc, xdr } from "@stellar/stellar-sdk";
import { nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import type {
  AccountAddress,
  ChainsConfig,
  Contracts,
  Network,
  TxHash,
  VAA,
  WormholeCore,
  WormholeMessageId,
} from "@wormhole-foundation/sdk-connect";
import { UniversalAddress, createVAA, encoding, serialize } from "@wormhole-foundation/sdk-connect";
import { StellarPlatform } from "@wormhole-foundation/sdk-stellar";
import type {
  StellarChains,
  StellarPlatformType,
  StellarUnsignedTransaction,
} from "@wormhole-foundation/sdk-stellar";

// A decoded `message_published` core event.
type PublishedMessage = {
  emitter: UniversalAddress;
  sequence: bigint;
  nonce: number;
  consistencyLevel: number;
  payload: Uint8Array;
};

// Soroban returns integers as `bigint` or `number` depending on their width, so
// callers cannot know which to expect. Convert through here rather than through
// a bare `BigInt(…)`/`Number(…)`, which would turn an unexpected shape (a
// `null` from an `Option`, a struct from a changed ABI) into `NaN` or a throw
// far from its cause.
function asBigInt(value: unknown, what: string): bigint {
  if (typeof value === "bigint" || typeof value === "number") return BigInt(value);
  throw new Error(`Expected an integer from ${what}, got: ${String(value)}`);
}

/**
 * WormholeCore bindings for the Stellar (Soroban) core contract.
 *
 * Reads (`getMessageFee`, `getGuardianSetIndex`, `getGuardianSet`,
 * `verifyMessage`) run as read-only simulations and never yield a transaction
 * to sign. `parseTransaction`/`parseMessages` reobserve a published message by
 * decoding the core's `message_published` events for a transaction.
 *
 * Publishing is not available through this class — see {@link publishMessage}.
 */
export class StellarWormholeCore<N extends Network, C extends StellarChains>
  implements WormholeCore<N, C>
{
  readonly coreAddress: string;

  constructor(
    readonly network: N,
    readonly chain: C,
    readonly provider: SorobanRpc.Server,
    readonly contracts: Contracts,
  ) {
    if (!contracts.coreBridge) throw new Error(`CoreBridge address for chain ${chain} not found`);
    this.coreAddress = contracts.coreBridge;
  }

  /** Build an instance from an RPC connection, resolving the chain from its network passphrase. */
  static async fromRpc<N extends Network>(
    provider: SorobanRpc.Server,
    config: ChainsConfig<N, StellarPlatformType>,
  ): Promise<StellarWormholeCore<N, StellarChains>> {
    const [network, chain] = await StellarPlatform.chainFromRpc(provider);
    const conf = config[chain]!;
    if (conf.network !== network)
      throw new Error(`Network mismatch: ${conf.network} !== ${network}`);
    return new StellarWormholeCore(network as N, chain, provider, conf.contracts);
  }

  /** The fee, in stroops, the core charges to publish a message (0 when unset). */
  async getMessageFee(): Promise<bigint> {
    return asBigInt(await this.read("get_message_fee"), "get_message_fee");
  }

  /** Index of the guardian set currently allowed to sign VAAs. */
  async getGuardianSetIndex(): Promise<number> {
    return Number(
      asBigInt(await this.read("get_current_guardian_set_index"), "get_current_guardian_set_index"),
    );
  }

  /**
   * The guardian set at `index`, with its 20-byte keys hex-encoded.
   *
   * `expiry` is 0 while the set is still current, matching the other platforms:
   * the contract's `get_guardian_set_expiry` is an `Option<u64>` that is only
   * populated once the set has been superseded by a guardian set upgrade.
   */
  async getGuardianSet(index: number): Promise<WormholeCore.GuardianSet> {
    const arg = nativeToScVal(index, { type: "u32" });
    const [info, expiry] = await Promise.all([
      this.read("get_guardian_set", arg),
      this.read("get_guardian_set_expiry", arg),
    ]);
    // get_guardian_set returns GuardianSetInfo { keys: Vec<BytesN<20>>, creation_time: u64 }.
    const { keys } = info as { keys: Uint8Array[]; creation_time: bigint };
    if (!Array.isArray(keys)) throw new Error("Expected guardian keys from get_guardian_set");
    return {
      index,
      keys: keys.map((k) => encoding.hex.encode(k)),
      expiry: expiry == null ? 0n : asBigInt(expiry, "get_guardian_set_expiry"),
    };
  }

  /**
   * Not supported on Stellar.
   *
   * The core's `post_message` requires the emitter to be a *contract* address
   * (it rejects anything but an `AddressPayload::ContractIdHash` with
   * `InvalidEmitterAddress`), and a contract emitter can only satisfy
   * `require_auth()` from inside its own invocation frame. A transaction
   * sourced by an account therefore has no way to publish: messages are emitted
   * by an integrator contract calling the core, not by this SDK.
   */
  async *publishMessage(
    _sender: AccountAddress<C>,
    _message: string | Uint8Array,
    _nonce: number,
    _consistencyLevel: number,
  ): AsyncGenerator<StellarUnsignedTransaction<N, C>> {
    throw new Error(
      "Stellar messages must be published by an integrator contract calling the core's " +
        "post_message; the core rejects account emitters, so publishMessage is not available.",
    );
  }

  /**
   * Check a VAA against the core's guardian set.
   *
   * `verify_vaa` is read-only, so this simulates the call — which reverts on an
   * invalid VAA — and returns without yielding a transaction to sign.
   */
  async *verifyMessage(_sender: AccountAddress<C>, vaa: VAA): AsyncGenerator<never> {
    await this.read("verify_vaa", nativeToScVal(Buffer.from(serialize(vaa)), { type: "bytes" }));
  }

  /** The message ids (chain/emitter/sequence) published by a transaction. */
  async parseTransaction(txid: TxHash): Promise<WormholeMessageId[]> {
    return (await this.parseEvents(txid)).map((m) => ({
      chain: this.chain,
      emitter: m.emitter,
      sequence: m.sequence,
    }));
  }

  /** The messages published by a transaction, as unsigned (reobserved) VAAs. */
  async parseMessages(txid: TxHash): Promise<VAA<"Uint8Array">[]> {
    return (await this.parseEvents(txid)).map((m) =>
      createVAA("Uint8Array", {
        emitterChain: this.chain,
        emitterAddress: m.emitter,
        sequence: m.sequence,
        guardianSet: 0,
        timestamp: 0,
        consistencyLevel: m.consistencyLevel,
        nonce: m.nonce,
        signatures: [],
        payload: m.payload,
      }),
    );
  }

  // Fetch and decode the core's `message_published` events for a transaction.
  private async parseEvents(txid: TxHash): Promise<PublishedMessage[]> {
    const tx = await this.provider.getTransaction(txid);
    if (tx.status !== "SUCCESS")
      throw new Error(`Stellar tx ${txid} did not succeed: ${tx.status}`);

    // The events of interest are all in the ledger the tx landed in; bounding
    // the query there keeps it from scanning every later ledger too.
    const { events } = await this.provider.getEvents({
      startLedger: tx.ledger,
      endLedger: tx.ledger + 1,
      filters: [{ type: "contract", contractIds: [this.coreAddress] }],
    });

    const messages: PublishedMessage[] = [];
    for (const ev of events) {
      if (ev.txHash !== txid) continue;
      if (!ev.topic.some((t) => scValToNative(t) === "message_published")) continue;

      // The event wire carries the raw 32-byte contract id as the emitter (not
      // the keccak256 hash_address), surfaced here as a raw UniversalAddress.
      // consistency_level is a U32 (1=Confirmed / 32=Finalized).
      const v = scValToNative(ev.value) as {
        nonce: number | bigint;
        sequence: number | bigint;
        emitter_address: Uint8Array;
        payload: Uint8Array;
        consistency_level: number | bigint;
      };
      messages.push({
        emitter: new UniversalAddress(v.emitter_address),
        sequence: asBigInt(v.sequence, "message_published.sequence"),
        nonce: Number(asBigInt(v.nonce, "message_published.nonce")),
        consistencyLevel: Number(
          asBigInt(v.consistency_level, "message_published.consistency_level"),
        ),
        payload: v.payload,
      });
    }
    return messages;
  }

  private read(method: string, ...args: xdr.ScVal[]): Promise<unknown> {
    return StellarPlatform.simulateRead(
      this.provider,
      this.network,
      this.coreAddress,
      method,
      ...args,
    );
  }
}
