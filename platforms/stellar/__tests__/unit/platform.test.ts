import { Account, Networks, Operation, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { StellarPlatform } from "../../src/platform.js";

const SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const BOUND = 1_800_000_000; // the transaction's maxTime, in Unix seconds

const tx = new TransactionBuilder(new Account(SOURCE, "41"), {
  fee: "100",
  networkPassphrase: Networks.TESTNET,
  timebounds: { minTime: 0, maxTime: BOUND },
})
  .addOperation(Operation.bumpSequence({ bumpTo: "0" }))
  .build();
const HASH = tx.hash().toString("hex");
const feeBump = TransactionBuilder.buildFeeBumpTransaction(SOURCE, "200", tx, Networks.TESTNET);

const errorResult = (result: xdr.TransactionResultResult) =>
  new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString("100"),
    result,
    ext: new xdr.TransactionResultExt(0),
  });

// The result of a fee bump whose inner transaction failed with `result`.
const innerFailed = (result: xdr.InnerTransactionResultResult) =>
  xdr.TransactionResultResult.txFeeBumpInnerFailed(
    new xdr.InnerTransactionResultPair({
      transactionHash: tx.hash(),
      result: new xdr.InnerTransactionResult({
        feeCharged: xdr.Int64.fromString("0"),
        result,
        ext: new xdr.InnerTransactionResultExt(0),
      }),
    }),
  );

describe("StellarPlatform.sendAndConfirm", () => {
  it.each([
    ["a tx", tx, xdr.TransactionResultResult.txBadAuth()],
    ["a fee bump", feeBump, innerFailed(xdr.InnerTransactionResultResult.txBadAuth())],
  ])(
    "reports the local hash and the rpc error result when %s fails to send",
    async (_, t, result) => {
      const rpc = {
        sendTransaction: async () => ({
          status: "ERROR",
          hash: "",
          errorResult: errorResult(result),
        }),
      } as any;
      await expect(StellarPlatform.sendAndConfirm(rpc, t)).rejects.toThrow(
        new RegExp(`${HASH}: ERROR txBadAuth \\(`),
      );
    },
  );
});
