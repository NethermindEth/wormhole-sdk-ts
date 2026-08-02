import {
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc as SorobanRpc,
  xdr,
} from "@stellar/stellar-sdk";
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
import {
  StellarAddress,
  StellarPlatform,
  StellarUnsignedTransaction,
  nativeSacId,
  stellarNetworkPassphrase,
} from "@wormhole-foundation/sdk-stellar";
import type {
  AnyStellarAddress,
  StellarChains,
  StellarPlatformType,
} from "@wormhole-foundation/sdk-stellar";

// A decoded `message_published` core event.
type PublishedMessage = {
  emitter: UniversalAddress;
  sequence: bigint;
  nonce: number;
  consistencyLevel: number;
  payload: Uint8Array;
};

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

  async getMessageFee(): Promise<bigint> {
    return BigInt((await this.read("get_message_fee")) as bigint | number);
  }

  async getGuardianSetIndex(): Promise<number> {
    return Number(await this.read("get_current_guardian_set_index"));
  }

  async getGuardianSet(index: number): Promise<WormholeCore.GuardianSet> {
    const arg = nativeToScVal(index, { type: "u32" });
    const [set, expiry] = await Promise.all([
      this.read("get_guardian_set", arg),
      this.read("get_guardian_set_expiry", arg),
    ]);
    // get_guardian_set returns the 20-byte guardian keys as a Vec<BytesN<20>>.
    const keys = (set as Uint8Array[]).map((k) => encoding.hex.encode(k));
    return { index, keys, expiry: BigInt(expiry as bigint | number) };
  }

  async *publishMessage(
    sender: AccountAddress<C>,
    message: string | Uint8Array,
    nonce: number,
    consistencyLevel: number,
  ): AsyncGenerator<StellarUnsignedTransaction<N, C>> {
    const from = new StellarAddress(sender as AnyStellarAddress).toString();
    const payload = message instanceof Uint8Array ? message : new TextEncoder().encode(message);

    // The core pulls the fee via transfer_from, so when a fee is set the sender
    // must first grant the core an allowance on the native XLM SAC. This yields
    // as its own (non-parallelizable) tx, so it is confirmed before post_message
    // is simulated below.
    const fee = await this.getMessageFee();
    if (fee > 0n) {
      const { sequence } = await this.provider.getLatestLedger();
      const approve = new Contract(nativeSacId(this.network)).call(
        "approve",
        new Address(from).toScVal(),
        new Address(this.coreAddress).toScVal(),
        nativeToScVal(fee, { type: "i128" }),
        nativeToScVal(sequence + 6000, { type: "u32" }),
      );
      yield await this.prepare(from, approve, "StellarWormholeCore.approve");
    }

    const post = new Contract(this.coreAddress).call(
      "post_message",
      new Address(from).toScVal(),
      nativeToScVal(nonce, { type: "u32" }),
      nativeToScVal(Buffer.from(payload), { type: "bytes" }),
      nativeToScVal(consistencyLevel, { type: "u32" }),
    );
    yield await this.prepare(from, post, "StellarWormholeCore.publishMessage");
  }

  // verify_vaa is read-only: simulate it (which reverts on an invalid VAA) and
  // return without yielding a transaction to sign.
  async *verifyMessage(_sender: AccountAddress<C>, vaa: VAA): AsyncGenerator<never> {
    await this.read("verify_vaa", nativeToScVal(Buffer.from(serialize(vaa)), { type: "bytes" }));
  }

  async parseTransaction(txid: TxHash): Promise<WormholeMessageId[]> {
    return (await this.parseEvents(txid)).map((m) => ({
      chain: this.chain,
      emitter: m.emitter,
      sequence: m.sequence,
    }));
  }

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
    if (tx.status !== "SUCCESS") return [];

    const { events } = await this.provider.getEvents({
      startLedger: tx.ledger,
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
        sequence: BigInt(v.sequence),
        nonce: Number(v.nonce),
        consistencyLevel: Number(v.consistency_level),
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

  private async prepare(
    from: string,
    operation: xdr.Operation,
    description: string,
  ): Promise<StellarUnsignedTransaction<N, C>> {
    const source = await this.provider.getAccount(from);
    const tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: stellarNetworkPassphrase(this.network),
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();
    const prepared = await this.provider.prepareTransaction(tx);
    return new StellarUnsignedTransaction(prepared, this.network, this.chain, description, false);
  }
}
