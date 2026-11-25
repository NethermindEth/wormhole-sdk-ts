import { jest } from "@jest/globals";
import { inspect } from "node:util";
import {
  Account,
  Contract,
  Keypair,
  MuxedAccount,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { StellarPlatform } from "../../src/platform.js";
import { StellarSigner, getStellarSigner } from "../../src/signer.js";
import type { StellarSignerOptions } from "../../src/signer.js";
import { StellarUnsignedTransaction } from "../../src/unsignedTransaction.js";

const keypair = Keypair.random();
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

// A signer whose RPC serves the network with `passphrase`.
const signerOn = (passphrase: string = Networks.TESTNET, opts?: StellarSignerOptions) =>
  getStellarSigner({ getNetwork: async () => ({ passphrase }) } as any, keypair.secret(), opts);

// A contract call from the signer's account, labelled Testnet, with the given overrides.
const call = ({
  passphrase = Networks.TESTNET as string,
  source = new Account(keypair.publicKey(), "1") as Account | MuxedAccount,
  maxTime = 1_800_000_000,
  fee = "100",
  ops = [new Contract(CONTRACT).call("transfer")] as xdr.Operation[],
} = {}) => {
  const builder = new TransactionBuilder(source, {
    fee,
    networkPassphrase: passphrase,
    timebounds: { minTime: 0, maxTime },
  });
  ops.forEach((op) => builder.addOperation(op));
  return new StellarUnsignedTransaction(builder.build(), "Testnet", "Stellar", "transfer");
};

let sent: jest.SpiedFunction<typeof StellarPlatform.sendAndConfirm>;
beforeEach(() => {
  sent = jest
    .spyOn(StellarPlatform, "sendAndConfirm")
    .mockImplementation(async (_, tx) => tx.hash().toString("hex"));
});
afterEach(() => jest.restoreAllMocks());

describe("StellarSigner", () => {
  it("keeps the secret key out of inspect and JSON", () => {
    const signer = new StellarSigner("Stellar", {} as any, keypair);
    expect(inspect(signer, { depth: null })).not.toMatch(/_secret/);
    expect(JSON.stringify(signer)).toBe(JSON.stringify(keypair.publicKey()));
  });

  it("signs and sends a contract call for the rpc's network", async () => {
    const utx = call();
    expect(await (await signerOn()).signAndSend([utx])).toEqual([
      utx.transaction.hash().toString("hex"),
    ]);
    expect(utx.transaction.signatures).toHaveLength(1);
  });

  it("refuses a transaction built for another network than its label", async () => {
    await expect(
      (await signerOn()).signAndSend([call({ passphrase: Networks.PUBLIC })]),
    ).rejects.toThrow(`passphrase "${Networks.PUBLIC}" is not Testnet's "${Networks.TESTNET}"`);
  });

  it("refuses a transaction for another network than the rpc serves", async () => {
    await expect((await signerOn(Networks.PUBLIC)).signAndSend([call()])).rejects.toThrow(
      "network Testnet is not the RPC's Mainnet",
    );
  });

  it("refuses a transaction for another chain", async () => {
    const utx = { ...call(), chain: "Solana" } as any;
    await expect((await signerOn()).signAndSend([utx])).rejects.toThrow(
      "StellarSigner refused transfer: chain Solana is not Stellar",
    );
  });

  it("sends nothing when a later transaction in the call is refused", async () => {
    const signer = await signerOn();
    await expect(
      signer.signAndSend([call(), call({ passphrase: Networks.PUBLIC })]),
    ).rejects.toThrow(/passphrase/);
    expect(sent).not.toHaveBeenCalled();
  });

  it("refuses a transaction from another source account", async () => {
    const other = Keypair.random().publicKey();
    await expect(
      (await signerOn()).signAndSend([call({ source: new Account(other, "1") })]),
    ).rejects.toThrow(`source ${other} is not ${keypair.publicKey()}`);
  });

  it("refuses an operation with another source account", async () => {
    const other = Keypair.random().publicKey();
    const ops = [
      Operation.invokeContractFunction({
        contract: CONTRACT,
        function: "transfer",
        args: [],
        source: other,
      }),
    ];
    await expect((await signerOn()).signAndSend([call({ ops })])).rejects.toThrow(
      `operation source ${other} is not ${keypair.publicKey()}`,
    );
  });

  it("signs a transaction from a muxed account of the signer's account", async () => {
    const source = new MuxedAccount(new Account(keypair.publicKey(), "1"), "7");
    expect(await (await signerOn()).signAndSend([call({ source })])).toHaveLength(1);
  });

  it("refuses a transaction with no upper time bound", async () => {
    await expect((await signerOn()).signAndSend([call({ maxTime: 0 })])).rejects.toThrow(
      "no upper time bound",
    );
  });

  it.each([
    ["two contract calls", [new Contract(CONTRACT).call("a"), new Contract(CONTRACT).call("b")]],
    ["a bumpSequence", [Operation.bumpSequence({ bumpTo: "0" })]],
  ])("refuses %s", async (_, ops) => {
    await expect((await signerOn()).signAndSend([call({ ops })])).rejects.toThrow(
      "are not one invokeHostFunction",
    );
  });

  it("refuses a fee above the default maxFee of 5 XLM", async () => {
    await expect((await signerOn()).signAndSend([call({ fee: "50000001" })])).rejects.toThrow(
      "fee 50000001 is above maxFee (50000000)",
    );
  });

  it("signs a fee of exactly 5 XLM", async () => {
    expect(await (await signerOn()).signAndSend([call({ fee: "50000000" })])).toHaveLength(1);
  });

  it("signs a fee up to the maxFee it was given", async () => {
    const signer = await signerOn(Networks.TESTNET, { maxFee: 100_000_000n });
    expect(await signer.signAndSend([call({ fee: "60000000" })])).toHaveLength(1);
  });
});
