import { StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { UniversalAddress, createVAA } from "@wormhole-foundation/sdk-connect";
import { StellarAddress } from "@wormhole-foundation/sdk-stellar";
import { StellarWormholeCore } from "../../src/core.js";

const CORE = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const TXID = "3389e9f0f1a0b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b";
const EMITTER = StrKey.decodeContract(CORE); // raw 32-byte contract id (the Core emitter form)
const LEDGER = 100;

// Build a `message_published` contract event as the RPC surfaces it: topics and
// value already parsed to xdr.ScVal. Field names/types follow the core ABI as
// observed on a localnet deployment.
const publishedEvent = (
  txHash: string,
  topic: string,
): { txHash: string; topic: xdr.ScVal[]; value: xdr.ScVal } => ({
  txHash,
  topic: [nativeToScVal(topic, { type: "symbol" })],
  value: nativeToScVal(
    {
      nonce: 7,
      sequence: 0n,
      emitter_address: Buffer.from(EMITTER),
      payload: Buffer.from([1, 2, 3]),
      consistency_level: 32,
    },
    {
      type: {
        nonce: ["symbol", "u32"],
        sequence: ["symbol", "u64"],
        emitter_address: ["symbol", "bytes"],
        payload: ["symbol", "bytes"],
        consistency_level: ["symbol", "u32"],
      },
    },
  ),
});

type ProviderOpts = {
  events?: unknown[];
  status?: string;
  // Per invoked method: the ScVal the contract returns, or an error message.
  // (An ScVal cannot be probed with `"error" in …` — every ScVal carries an
  // `error()` arm accessor — so the two cases are told apart by type.)
  reads?: Record<string, xdr.ScVal | string>;
};

// Records every getEvents request so tests can assert the query is bounded.
const eventRequests: any[] = [];

const providerWith = ({ events = [], status = "SUCCESS", reads = {} }: ProviderOpts) =>
  ({
    getTransaction: async (hash: string) => ({ status, ledger: LEDGER, txHash: hash }),
    getEvents: async (req: any) => {
      eventRequests.push(req);
      return { events, latestLedger: LEDGER, cursor: "" };
    },
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

beforeEach(() => (eventRequests.length = 0));

describe("StellarWormholeCore.parse", () => {
  it("decodes a message_published event into a reobserved VAA", async () => {
    const [vaa] = await coreWith({
      events: [publishedEvent(TXID, "message_published")],
    }).parseMessages(TXID);
    expect(vaa!.emitterChain).toBe("Stellar");
    expect(vaa!.sequence).toBe(0n);
    expect(vaa!.nonce).toBe(7);
    expect(vaa!.consistencyLevel).toBe(32);
    expect(vaa!.payload).toEqual(new Uint8Array([1, 2, 3]));
    expect(vaa!.signatures).toHaveLength(0);
    // emitter is the raw contract id, NOT the keccak256 hash_address
    expect(vaa!.emitterAddress.equals(new UniversalAddress(new Uint8Array(EMITTER)))).toBe(true);
    expect(vaa!.emitterAddress.equals(new StellarAddress(CORE).toUniversalAddress())).toBe(false);
  });

  it("parseTransaction surfaces the message id", async () => {
    const [id] = await coreWith({
      events: [publishedEvent(TXID, "message_published")],
    }).parseTransaction(TXID);
    expect(id!.chain).toBe("Stellar");
    expect(id!.sequence).toBe(0n);
  });

  it("ignores events from other txs and non-message topics", async () => {
    const core = coreWith({
      events: [publishedEvent("deadbeef", "message_published"), publishedEvent(TXID, "transfer")],
    });
    expect(await core.parseMessages(TXID)).toHaveLength(0);
  });

  it("bounds the event query to the ledger the tx landed in", async () => {
    await coreWith({ events: [publishedEvent(TXID, "message_published")] }).parseMessages(TXID);
    expect(eventRequests).toHaveLength(1);
    expect(eventRequests[0]).toMatchObject({ startLedger: LEDGER, endLedger: LEDGER + 1 });
  });

  it("throws rather than reporting no messages when the tx failed", async () => {
    await expect(coreWith({ status: "FAILED" }).parseMessages(TXID)).rejects.toThrow(
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
