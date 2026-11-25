import { jest } from "@jest/globals";
import { inspect } from "node:util";
import { Account, Contract, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { StellarPlatform } from "../../src/platform.js";
import { StellarSigner, getStellarSigner } from "../../src/signer.js";
import { StellarUnsignedTransaction } from "../../src/unsignedTransaction.js";

const keypair = Keypair.random();
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

// A signer whose RPC serves the network with `passphrase`.
const signerOn = (passphrase: string = Networks.TESTNET) =>
  getStellarSigner({ getNetwork: async () => ({ passphrase }) } as any, keypair.secret());

// A contract call from the signer's account, labelled Testnet.
const call = ({ passphrase = Networks.TESTNET as string } = {}) =>
  new StellarUnsignedTransaction(
    new TransactionBuilder(new Account(keypair.publicKey(), "1"), {
      fee: "100",
      networkPassphrase: passphrase,
      timebounds: { minTime: 0, maxTime: 1_800_000_000 },
    })
      .addOperation(new Contract(CONTRACT).call("transfer"))
      .build(),
    "Testnet",
    "Stellar",
    "transfer",
  );

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
});
