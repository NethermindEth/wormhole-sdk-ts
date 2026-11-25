import { Networks, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { UniversalAddress, createVAA } from "@wormhole-foundation/sdk-connect";
import { StellarAddress } from "@wormhole-foundation/sdk-stellar";
import { StellarWormholeCore } from "../../src/core.js";

const CORE = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const OTHER = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const TXID = "3389e9f0f1a0b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b";
const EMITTER = StrKey.decodeContract(CORE); // raw 32-byte contract id (the Core emitter form)

const symbol = (s: string) => nativeToScVal(s, { type: "symbol" });
const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
const entry = (key: xdr.ScVal, val: xdr.ScVal) => new xdr.ScMapEntry({ key, val });

// The fields of a core `message_published` event. Names and types follow the
// core ABI as observed on a localnet deployment.
const MESSAGE = {
  nonce: u32(7),
  sequence: nativeToScVal(0n, { type: "u64" }),
  emitter_address: nativeToScVal(Buffer.from(EMITTER)),
  payload: nativeToScVal(Buffer.from([1, 2, 3])),
  consistency_level: u32(32),
};

// The data of a `message_published` event, with fields replaced, added, or
// removed when set to `undefined`.
const message = (fields: Record<string, xdr.ScVal | undefined> = {}) =>
  xdr.ScVal.scvMap(
    Object.entries({ ...MESSAGE, ...fields }).flatMap(([k, v]) => (v ? [entry(symbol(k), v)] : [])),
  );

// Build a contract event as a transaction's result meta holds it: by default,
// a `message_published` event from the core.
const publishedEvent = ({
  contract = CORE,
  type = xdr.ContractEventType.contract(),
  topics = [symbol("wormhole"), symbol("message_published")],
  data = message(),
} = {}) =>
  new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    contractId: StrKey.decodeContract(contract) as any,
    type,
    body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics, data })),
  });

// The result meta of a Soroban transaction since protocol 23 (v4), and before it
// (v3), decoded from XDR the way the RPC client decodes it.
const decoded = (meta: xdr.TransactionMeta) => xdr.TransactionMeta.fromXDR(meta.toXDR());
const metaV4 = (events: xdr.ContractEvent[], diagnosticEvents: xdr.DiagnosticEvent[] = []) =>
  decoded(
    new xdr.TransactionMeta(
      4,
      new xdr.TransactionMetaV4({
        ext: new xdr.ExtensionPoint(0),
        txChangesBefore: [],
        operations: [
          new xdr.OperationMetaV2({ ext: new xdr.ExtensionPoint(0), changes: [], events }),
        ],
        txChangesAfter: [],
        sorobanMeta: null,
        events: [],
        diagnosticEvents,
      }),
    ),
  );
const metaV3 = (events: xdr.ContractEvent[]) =>
  decoded(
    new xdr.TransactionMeta(
      3,
      new xdr.TransactionMetaV3({
        ext: new xdr.ExtensionPoint(0),
        txChangesBefore: [],
        operations: [new xdr.OperationMeta({ changes: [] })],
        txChangesAfter: [],
        sorobanMeta: new xdr.SorobanTransactionMeta({
          ext: new xdr.SorobanTransactionMetaExt(0),
          events,
          returnValue: xdr.ScVal.scvVoid(),
          diagnosticEvents: [],
        }),
      }),
    ),
  );

type ProviderOpts = {
  // The contract events of the transaction, held in v4 meta.
  events?: xdr.ContractEvent[];
  // Overrides for the rest of the getTransaction response.
  tx?: Record<string, unknown>;
  // Per invoked method: the ScVal the contract returns, or an error message.
  // (An ScVal cannot be probed with `"error" in …` — every ScVal carries an
  // `error()` arm accessor — so the two cases are told apart by type.)
  reads?: Record<string, xdr.ScVal | string>;
};

const providerWith = ({ events = [], tx = {}, reads = {} }: ProviderOpts) =>
  ({
    getNetwork: async () => ({ passphrase: Networks.TESTNET }),
    getTransaction: async () => ({ status: "SUCCESS", resultMetaXdr: metaV4(events), ...tx }),
    simulateTransaction: async (tx: any) => {
      // The read-only builder puts exactly one InvokeHostFunction op on the tx.
      const method = tx.operations[0]!.func.invokeContract().functionName().toString();
      const result = reads[method];
      if (result === undefined) return { error: `no mocked result for ${method}` };
      if (typeof result === "string") return { error: result };
      return { result: { retval: result } };
    },
  }) as any;

const coreWith = (opts: ProviderOpts) =>
  new StellarWormholeCore("Testnet", "Stellar", providerWith(opts), { coreBridge: CORE });

const drain = async (gen: AsyncGenerator<unknown>) => {
  const out = [];
  for await (const item of gen) out.push(item);
  return out;
};

describe("StellarWormholeCore.parse", () => {
  it("decodes a message_published event into a reobserved VAA", async () => {
    const [vaa] = await coreWith({ events: [publishedEvent()] }).parseMessages(TXID);
    expect(vaa!.emitterChain).toBe("Stellar");
    expect(vaa!.sequence).toBe(0n);
    expect(vaa!.nonce).toBe(7);
    expect(vaa!.consistencyLevel).toBe(32);
    expect([...vaa!.payload]).toEqual([1, 2, 3]);
    expect(vaa!.signatures).toHaveLength(0);
    // emitter is the raw contract id, NOT the keccak256 hash_address
    expect(vaa!.emitterAddress.equals(new UniversalAddress(new Uint8Array(EMITTER)))).toBe(true);
    expect(vaa!.emitterAddress.equals(new StellarAddress(CORE).toUniversalAddress())).toBe(false);
  });

  it("parseTransaction surfaces the message id", async () => {
    const [id] = await coreWith({ events: [publishedEvent()] }).parseTransaction(TXID);
    expect(id!.chain).toBe("Stellar");
    expect(id!.sequence).toBe(0n);
  });

  it("reads the events from v3 meta", async () => {
    const core = coreWith({ tx: { resultMetaXdr: metaV3([publishedEvent()]) } });
    expect(await core.parseTransaction(TXID)).toHaveLength(1);
  });

  it("reads a fee bump transaction", async () => {
    const core = coreWith({ events: [publishedEvent()], tx: { feeBump: true } });
    expect(await core.parseTransaction(TXID)).toHaveLength(1);
  });

  it("accepts an uppercase hash", async () => {
    const core = coreWith({ events: [publishedEvent()] });
    expect(await core.parseTransaction(TXID.toUpperCase())).toHaveLength(1);
  });

  // Diagnostic events repeat the events of successful calls, and add those of
  // calls that failed.
  it.each([true, false])(
    "never reads diagnostic events (inSuccessfulContractCall: %s)",
    async (inSuccessfulContractCall) => {
      const event = new xdr.DiagnosticEvent({ inSuccessfulContractCall, event: publishedEvent() });
      const core = coreWith({ tx: { resultMetaXdr: metaV4([], [event]) } });
      expect(await core.parseMessages(TXID)).toHaveLength(0);
    },
  );

  it("ignores another contract's events and non-message topics", async () => {
    const core = coreWith({
      events: [
        publishedEvent({ contract: OTHER }),
        publishedEvent({ topics: [symbol("wormhole"), symbol("transfer")] }),
      ],
    });
    expect(await core.parseMessages(TXID)).toHaveLength(0);
  });

  // The guardian watcher never signs these, so they are not messages.
  it.each([
    ["a string topic", { topics: [symbol("wormhole"), nativeToScVal("message_published")] }],
    ["one topic", { topics: [symbol("wormhole")] }],
    ["swapped topics", { topics: [symbol("message_published"), symbol("wormhole")] }],
    [
      "three topics",
      { topics: [symbol("wormhole"), symbol("message_published"), symbol("wormhole")] },
    ],
    ["a non-map value", { data: u32(1) }],
    ["a system event type", { type: xdr.ContractEventType.system() }],
    ["an extra data field", { data: message({ extra: u32(1) }) }],
    ["a missing data field", { data: message({ payload: undefined }) }],
    ["a field of the wrong type", { data: message({ nonce: nativeToScVal(7n, { type: "u64" }) }) }],
    [
      "a string key",
      {
        data: xdr.ScVal.scvMap([
          entry(nativeToScVal("nonce"), u32(7)),
          ...message({ nonce: undefined }).map()!,
        ]),
      },
    ],
    [
      "a duplicate key",
      { data: xdr.ScVal.scvMap([...message().map()!, entry(symbol("nonce"), u32(8))]) },
    ],
    ["a 20-byte emitter", { data: message({ emitter_address: nativeToScVal(Buffer.alloc(20)) }) }],
    ["a consistency level of 256", { data: message({ consistency_level: u32(256) }) }],
  ])("ignores an event with %s", async (_, event) => {
    expect(await coreWith({ events: [publishedEvent(event)] }).parseMessages(TXID)).toHaveLength(0);
  });

  it.each([200, 255])("accepts a consistency level of %i", async (level) => {
    const event = publishedEvent({ data: message({ consistency_level: u32(level) }) });
    const [vaa] = await coreWith({ events: [event] }).parseMessages(TXID);
    expect(vaa!.consistencyLevel).toBe(level);
  });

  it("names the RPC history window when the tx is not found", async () => {
    const core = coreWith({ tx: { status: "NOT_FOUND", oldestLedger: 50 } });
    await expect(core.parseMessages(TXID)).rejects.toThrow(
      /not found yet, or older than this RPC's oldest ledger 50$/,
    );
  });

  it("throws rather than reporting no messages when the tx failed", async () => {
    await expect(coreWith({ tx: { status: "FAILED" } }).parseMessages(TXID)).rejects.toThrow(
      /did not succeed: FAILED/,
    );
  });
});

describe("StellarWormholeCore reads", () => {
  it("returns the message fee", async () => {
    const core = coreWith({ reads: { get_message_fee: nativeToScVal(100n, { type: "u64" }) } });
    expect(await core.getMessageFee()).toBe(100n);
  });

  it("returns the current guardian set index", async () => {
    const core = coreWith({
      reads: { get_current_guardian_set_index: nativeToScVal(3, { type: "u32" }) },
    });
    expect(await core.getGuardianSetIndex()).toBe(3);
  });

  // A missing or reshaped return would otherwise become NaN / BigInt(NaN).
  it("throws instead of yielding NaN when a read returns an unexpected shape", async () => {
    const core = coreWith({ reads: { get_message_fee: xdr.ScVal.scvVoid() } });
    await expect(core.getMessageFee()).rejects.toThrow(/Expected an integer from get_message_fee/);
  });

  it("decodes GuardianSetInfo and treats a null expiry as not expired", async () => {
    const keys = ["c6ef12cbab104f611924c1a66b542231b7261b13"];
    const core = coreWith({
      reads: {
        get_guardian_set: xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: nativeToScVal("creation_time", { type: "symbol" }),
            val: nativeToScVal(1n, { type: "u64" }),
          }),
          new xdr.ScMapEntry({
            key: nativeToScVal("keys", { type: "symbol" }),
            val: xdr.ScVal.scvVec(keys.map((k) => xdr.ScVal.scvBytes(Buffer.from(k, "hex")))),
          }),
        ]),
        // get_guardian_set_expiry is an Option<u64>; None while the set is current.
        get_guardian_set_expiry: xdr.ScVal.scvVoid(),
      },
    });
    expect(await core.getGuardianSet(0)).toEqual({ index: 0, keys, expiry: 0n });
  });

  it("verifyMessage simulates verify_vaa and yields no transaction", async () => {
    const core = coreWith({ reads: { verify_vaa: xdr.ScVal.scvVoid() } });
    expect(await drain(core.verifyMessage(new StellarAddress(CORE), vaa()))).toEqual([]);
  });

  it("verifyMessage surfaces a failing verification", async () => {
    const core = coreWith({ reads: { verify_vaa: "InvalidSignature" } });
    await expect(drain(core.verifyMessage(new StellarAddress(CORE), vaa()))).rejects.toThrow(
      /Simulation failed for verify_vaa/,
    );
  });
});

describe("StellarWormholeCore.publishMessage", () => {
  // The core rejects account emitters (InvalidEmitterAddress) and a contract
  // emitter cannot authorize itself from an account-sourced transaction, so
  // there is no input this can serve.
  it("reports that publishing must go through an integrator contract", async () => {
    const core = coreWith({});
    await expect(
      drain(core.publishMessage(new StellarAddress(CORE), new Uint8Array([1]), 0, 1)),
    ).rejects.toThrow(/must be published by an integrator contract/);
  });
});

function vaa() {
  return createVAA("Uint8Array", {
    guardianSet: 0,
    timestamp: 0,
    nonce: 0,
    emitterChain: "Stellar",
    emitterAddress: new UniversalAddress(new Uint8Array(EMITTER)),
    sequence: 0n,
    consistencyLevel: 32,
    signatures: [],
    payload: new Uint8Array([1, 2, 3]),
  });
}
