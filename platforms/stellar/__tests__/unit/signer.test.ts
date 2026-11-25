import { inspect } from "node:util";
import { Keypair } from "@stellar/stellar-sdk";
import { StellarSigner } from "../../src/signer.js";

const keypair = Keypair.random();

describe("StellarSigner", () => {
  it("keeps the secret key out of inspect and JSON", () => {
    const signer = new StellarSigner("Stellar", {} as any, keypair);
    expect(inspect(signer, { depth: null })).not.toMatch(/_secret/);
    expect(JSON.stringify(signer)).toBe(JSON.stringify(keypair.publicKey()));
  });
});
