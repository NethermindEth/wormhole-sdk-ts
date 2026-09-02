import { StrKey, rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { UniversalAddress, createVAA } from "@wormhole-foundation/sdk-connect";
import { mocks } from "@wormhole-foundation/sdk-definitions/testing";
import { StellarAddress } from "@wormhole-foundation/sdk-stellar";
import { StellarWormholeCore } from "../../src/core.js";

/**
 * Round trip against a running Stellar network with the core deployed.
 *
 * Skipped unless the environment describes such a deployment:
 *
 *   STELLAR_RPC                 soroban-rpc url (localnet: http://localhost:8000/rpc)
 *   STELLAR_CORE_CONTRACT       the deployed core's contract id
 *   STELLAR_EMITTER_CONTRACT    contract id that published STELLAR_PUBLISH_TXID
 *   STELLAR_PUBLISH_TXID        a tx in which that contract called post_message
 *   STELLAR_GUARDIAN_KEYS       optional; comma-separated guardian private keys
 *                               for the deployed set, to exercise verify_vaa
 *
 * To produce them on a localnet: run the stellar quickstart image, deploy the
 * core from NethermindEth/wormhole (`stellar` branch), then have a contract of
 * your own call `post_message` — the core rejects account emitters, so the
 * publishing caller has to be a contract.
 */
const { STELLAR_RPC, STELLAR_CORE_CONTRACT, STELLAR_EMITTER_CONTRACT, STELLAR_PUBLISH_TXID } =
  process.env;

const configured = !!(
  STELLAR_RPC &&
  STELLAR_CORE_CONTRACT &&
  STELLAR_EMITTER_CONTRACT &&
  STELLAR_PUBLISH_TXID
);

(configured ? describe : describe.skip)("StellarWormholeCore against a live core", () => {
  // Built in beforeAll: a skipped describe still runs its callback, so nothing
  // here may touch the (absent) environment when the suite is skipped.
  let core: StellarWormholeCore<"Devnet", "Stellar">;
  let sender: StellarAddress;
  let emitter: UniversalAddress;

  beforeAll(() => {
    const provider = new SorobanRpc.Server(STELLAR_RPC!, {
      allowHttp: STELLAR_RPC!.startsWith("http:"),
    });
    core = new StellarWormholeCore("Devnet", "Stellar", provider, {
      coreBridge: STELLAR_CORE_CONTRACT!,
    });
    sender = new StellarAddress(STELLAR_EMITTER_CONTRACT!);
    emitter = new UniversalAddress(
      new Uint8Array(StrKey.decodeContract(STELLAR_EMITTER_CONTRACT!)),
    );
  });

  const drain = async (gen: AsyncGenerator<unknown>) => {
    const out = [];
    for await (const item of gen) out.push(item);
    return out;
  };

  it("reads the message fee and guardian set", async () => {
    expect(typeof (await core.getMessageFee())).toBe("bigint");

    const index = await core.getGuardianSetIndex();
    expect(Number.isInteger(index)).toBe(true);

    const set = await core.getGuardianSet(index);
    expect(set.index).toBe(index);
    expect(set.keys.length).toBeGreaterThan(0);
    // 20-byte guardian addresses, hex encoded
    for (const key of set.keys) expect(key).toMatch(/^[0-9a-f]{40}$/);
    // Option<u64> on chain: 0 while the set is still the current one
    expect(typeof set.expiry).toBe("bigint");
  });

  it("reobserves a published message from its transaction", async () => {
    const [id, ...rest] = await core.parseTransaction(STELLAR_PUBLISH_TXID!);
    expect(rest).toHaveLength(0);
    expect(id!.chain).toBe("Stellar");
    // the core emits the raw 32-byte contract id, not the keccak256 hash_address
    expect(id!.emitter.equals(emitter)).toBe(true);

    const [vaa, ...more] = await core.parseMessages(STELLAR_PUBLISH_TXID!);
    expect(more).toHaveLength(0);
    expect(vaa!.emitterChain).toBe("Stellar");
    expect(vaa!.emitterAddress.equals(emitter)).toBe(true);
    expect(vaa!.sequence).toBe(id!.sequence);
    expect(vaa!.signatures).toHaveLength(0);
    expect(vaa!.payload.length).toBeGreaterThan(0);
  });

  it("rejects a transaction hash that did not succeed", async () => {
    await expect(core.parseMessages("00".repeat(32))).rejects.toThrow(/did not succeed/);
  });

  it("cannot publish: the core only accepts contract emitters", async () => {
    await expect(drain(core.publishMessage(sender, new Uint8Array([1]), 0, 1))).rejects.toThrow(
      /integrator contract/,
    );
  });

  const guardianKeys = process.env["STELLAR_GUARDIAN_KEYS"]?.split(",").filter(Boolean) ?? [];
  (guardianKeys.length ? it : it.skip)("verifies a guardian-signed VAA on chain", async () => {
    const guardians = new mocks.MockGuardians(await core.getGuardianSetIndex(), guardianKeys);
    const unsigned = createVAA("Uint8Array", {
      guardianSet: await core.getGuardianSetIndex(),
      timestamp: 0,
      nonce: 7,
      emitterChain: "Stellar",
      emitterAddress: emitter,
      sequence: 0n,
      consistencyLevel: 32,
      signatures: [],
      payload: new Uint8Array([1, 2, 3, 4]),
    });

    // a full quorum verifies (and yields no transaction, verify_vaa is read-only)
    const signed = guardians.addSignatures(unsigned, [...guardianKeys.keys()]);
    expect(await drain(core.verifyMessage(sender, signed))).toEqual([]);

    // one signature short of quorum is rejected by the contract
    const short = guardians.addSignatures(
      createVAA("Uint8Array", { ...unsigned, signatures: [] }),
      [0],
    );
    await expect(drain(core.verifyMessage(sender, short))).rejects.toThrow(
      /Simulation failed for verify_vaa/,
    );
  });
});
