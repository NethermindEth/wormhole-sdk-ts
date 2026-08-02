import { StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { UniversalAddress } from "@wormhole-foundation/sdk-connect";
import { StellarAddress } from "@wormhole-foundation/sdk-stellar";
import { StellarWormholeCore } from "../../src/core.js";

const CORE = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const TXID = "3389e9f0f1a0b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b";
const EMITTER = StrKey.decodeContract(CORE); // raw 32-byte contract id (the Core emitter form)

// Build a `message_published` contract event as the RPC surfaces it: topics and
// value already parsed to xdr.ScVal. Field names/types follow the core ABI.
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

const providerWith = (events: unknown[]) =>
  ({
    getTransaction: async (hash: string) => ({ status: "SUCCESS", ledger: 100, txHash: hash }),
    getEvents: async () => ({ events, latestLedger: 100, cursor: "" }),
  }) as any;

const coreWith = (events: unknown[]) =>
  new StellarWormholeCore("Testnet", "Stellar", providerWith(events), { coreBridge: CORE });

describe("StellarWormholeCore.parse", () => {
  it("decodes a message_published event into a reobserved VAA", async () => {
    const [vaa] = await coreWith([publishedEvent(TXID, "message_published")]).parseMessages(TXID);
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
    const [id] = await coreWith([publishedEvent(TXID, "message_published")]).parseTransaction(TXID);
    expect(id!.chain).toBe("Stellar");
    expect(id!.sequence).toBe(0n);
  });

  it("ignores events from other txs and non-message topics", async () => {
    const core = coreWith([
      publishedEvent("deadbeef", "message_published"),
      publishedEvent(TXID, "transfer"),
    ]);
    expect(await core.parseMessages(TXID)).toHaveLength(0);
  });
});
