import { Networks } from "@stellar/stellar-sdk";
import { toChainId } from "@wormhole-foundation/sdk-connect";
import { stellarNetworkPassphrase } from "../../src/constants.js";

describe("Stellar registration constants", () => {
  it.each([
    ["Mainnet", Networks.PUBLIC],
    ["Testnet", Networks.TESTNET],
    ["Devnet", Networks.STANDALONE],
  ] as const)("gives %s the passphrase %s", (network, passphrase) => {
    expect(stellarNetworkPassphrase(network)).toBe(passphrase);
  });

  it("registers Stellar as chain id 61", () => {
    expect(toChainId("Stellar")).toBe(61);
  });
});
