import { jest } from "@jest/globals";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc as SorobanRpc,
  xdr,
} from "@stellar/stellar-sdk";
import type { FeeBumpTransaction, Transaction } from "@stellar/stellar-sdk";
import { networkPlatformConfigs } from "@wormhole-foundation/sdk-connect";
import { StellarPlatform, StellarTxOutcomeUnknownError } from "../../src/platform.js";

const SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const BOUND = 1_800_000_000; // the transaction's maxTime, in Unix seconds

// A tx with sequence 42 from SOURCE, valid until maxTime (0 means no upper bound).
const build = (maxTime: number) =>
  new TransactionBuilder(new Account(SOURCE, "41"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
    timebounds: { minTime: 0, maxTime },
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "0" }))
    .build();
const tx = build(BOUND);
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

// The RPC sends latestLedgerCloseTime as a numeric string.
const notFound = (closeTime: number, latestLedger: number) => ({
  status: "NOT_FOUND",
  latestLedger,
  latestLedgerCloseTime: String(closeTime),
});
const landed = (t: Transaction | FeeBumpTransaction) => ({
  status: "SUCCESS",
  envelopeXdr: t.toEnvelope(),
});
const accountAt = (latestLedger: number, seq: string) => ({
  latestLedger,
  entries: [{ val: { account: () => ({ seqNum: () => seq }) } }],
});

// Answers each call with the next reply, then repeats the last one. An Error reply is thrown.
const replies =
  (...rs: unknown[]) =>
  async () => {
    const r = rs.length > 1 ? rs.shift() : rs[0];
    if (r instanceof Error) throw r;
    return r;
  };

const rpcWith = ({
  send = { status: "PENDING" } as unknown,
  polls,
  accounts = [],
}: {
  send?: unknown;
  polls: unknown[];
  accounts?: unknown[];
}) => ({
  sendTransaction: replies(send),
  getTransaction: jest.fn(replies(...polls)),
  getLedgerEntries: replies(...accounts),
});

// Runs sendAndConfirm on the fake clock and returns its hash, or the error it threw.
const outcome = async (rpc: object, t: Transaction | FeeBumpTransaction = tx) => {
  const done = StellarPlatform.sendAndConfirm(rpc as any, t).catch((e: unknown) => e);
  await jest.runAllTimersAsync();
  return done;
};

beforeEach(() => jest.useFakeTimers({ now: (BOUND - 30) * 1000 }));
afterEach(() => jest.useRealTimers());

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
        getTransaction: async () => ({ status: "NOT_FOUND" }),
      } as any;
      await expect(StellarPlatform.sendAndConfirm(rpc, t)).rejects.toThrow(
        new RegExp(`${HASH}: ERROR txBadAuth \\(`),
      );
    },
  );

  it.each([
    ["DUPLICATE", { status: "DUPLICATE" }, tx],
    [
      "txBAD_SEQ",
      {
        status: "ERROR",
        errorResult: errorResult(xdr.TransactionResultResult.txBadSeq()),
      },
      tx,
    ],
    [
      "txTOO_LATE",
      {
        status: "ERROR",
        errorResult: errorResult(xdr.TransactionResultResult.txTooLate()),
      },
      tx,
    ],
    [
      "txINSUFFICIENT_FEE",
      {
        status: "ERROR",
        errorResult: errorResult(xdr.TransactionResultResult.txInsufficientFee()),
      },
      tx,
    ],
    [
      "a fee bump's inner txBAD_SEQ",
      {
        status: "ERROR",
        errorResult: errorResult(innerFailed(xdr.InnerTransactionResultResult.txBadSeq())),
      },
      feeBump,
    ],
    [
      "a landed fee bump's outer txINSUFFICIENT_BALANCE",
      {
        status: "ERROR",
        errorResult: errorResult(xdr.TransactionResultResult.txInsufficientBalance()),
      },
      feeBump,
    ],
    ["a thrown send", new Error("socket hang up"), tx],
  ])("polls after %s and reports success", async (_, send, t) => {
    expect(await outcome(rpcWith({ send, polls: [landed(t)] }), t)).toBe(t.hash().toString("hex"));
  });

  it("polls through TRY_AGAIN_LATER and NOT_FOUND until success", async () => {
    const rpc = rpcWith({
      send: { status: "TRY_AGAIN_LATER" },
      polls: [notFound(BOUND - 20, 100), landed(tx)],
    });
    expect(await outcome(rpc)).toBe(HASH);
  });

  it("reports failure when the tx fails on chain", async () => {
    expect(await outcome(rpcWith({ polls: [{ status: "FAILED" }] }))).toEqual(
      new Error(`Stellar tx ${HASH} failed: FAILED`),
    );
  });

  it("reports failure past the bound when the account sequence is below the tx's", async () => {
    const rpc = rpcWith({
      polls: [notFound(BOUND - 1, 100), notFound(BOUND + 1, 101)],
      accounts: [accountAt(101, "41")],
    });
    expect(await outcome(rpc)).toEqual(
      new Error(`Stellar tx ${HASH} failed: expired at time bound ${BOUND}`),
    );
  });

  it("keeps polling a late send until a current replica shows its sequence", async () => {
    jest.setSystemTime((BOUND + 120) * 1000);
    const rpc = rpcWith({
      send: {
        status: "ERROR",
        errorResult: errorResult(xdr.TransactionResultResult.txTooLate()),
      },
      polls: [notFound(BOUND + 120, 200)],
      accounts: [accountAt(199, "41"), accountAt(200, "41")],
    });
    const error = await outcome(rpc);
    expect(error).toEqual(new Error(`Stellar tx ${HASH} failed: expired at time bound ${BOUND}`));
    expect((error as Error).cause).toMatchObject({
      message: expect.stringContaining("ERROR txTooLate ("),
    });
  });

  it.each([
    ["the tx's sequence is consumed", accountAt(101, "42")],
    ["the source account is gone", { latestLedger: 101, entries: [] }],
  ])("reports an unknown outcome past the bound when %s", async (_, account) => {
    const rpc = rpcWith({
      polls: [notFound(BOUND + 1, 101)],
      accounts: [account],
    });
    const error = await outcome(rpc);
    expect(error).toBeInstanceOf(StellarTxOutcomeUnknownError);
    expect(error).toMatchObject({
      name: "StellarTxOutcomeUnknownError",
      hash: HASH,
      maxTime: BOUND,
    });
  });

  it.each([
    ["behind the bound", notFound(BOUND - 10, 100)],
    ["not a numeric string", { ...notFound(BOUND - 10, 100), latestLedgerCloseTime: "1e10" }],
  ])("reports an unknown outcome at the limit when the rpc's close time is %s", async (_, poll) => {
    const error = await outcome(rpcWith({ polls: [poll], accounts: [accountAt(100, "41")] }));
    expect(error).toBeInstanceOf(StellarTxOutcomeUnknownError);
    expect(Date.now()).toBeGreaterThanOrEqual((BOUND + 60) * 1000);
  });

  it("keeps the first rpc error as the cause of an unknown outcome", async () => {
    const down = new Error("401 Unauthorized");
    const rpc = rpcWith({ send: down, polls: [new Error("socket hang up")] });
    expect(await outcome(rpc)).toMatchObject({
      name: "StellarTxOutcomeUnknownError",
      cause: down,
    });
  });

  it("does not trust an account read from a replica behind the bound", async () => {
    const rpc = rpcWith({
      polls: [notFound(BOUND + 1, 101), landed(tx)],
      accounts: [accountAt(100, "41")],
    });
    expect(await outcome(rpc)).toBe(HASH);
  });

  it("polls a fee bump by its inner hash and returns the landed envelope's hash", async () => {
    const replacement = TransactionBuilder.buildFeeBumpTransaction(
      SOURCE,
      "300",
      tx,
      Networks.TESTNET,
    );
    const rpc = rpcWith({ polls: [landed(replacement)] });
    expect(await outcome(rpc, feeBump)).toBe(replacement.hash().toString("hex"));
    expect(rpc.getTransaction.mock.calls).toEqual([[HASH]]);
  });

  it("returns the hash of an envelope parsed by another copy of stellar-sdk", async () => {
    // Each copy has its own XDR classes and enum objects. A fee bump meets both envelope type
    // checks of stellar-base.
    let sdk: typeof import("@stellar/stellar-sdk") | undefined;
    await jest.isolateModulesAsync(async () => {
      sdk = await import("@stellar/stellar-sdk");
    });
    expect(sdk!.xdr).not.toBe(xdr);
    const envelopeXdr = sdk!.xdr.TransactionEnvelope.fromXDR(feeBump.toXDR(), "base64");
    const rpc = rpcWith({ polls: [{ status: "SUCCESS", envelopeXdr }] });
    expect(await outcome(rpc, feeBump)).toBe(feeBump.hash().toString("hex"));
  });

  it("never reports a tx with no time bound failed", async () => {
    const unbounded = build(0);
    const rpc = rpcWith({
      polls: [notFound(BOUND + 100, 200)],
      accounts: [accountAt(200, "41")],
    });
    expect(await outcome(rpc, unbounded)).toMatchObject({
      name: "StellarTxOutcomeUnknownError",
      hash: unbounded.hash().toString("hex"),
      maxTime: 0,
    });
    expect(Date.now()).toBeGreaterThanOrEqual((BOUND - 30 + 60) * 1000);
  });
});

describe("StellarPlatform.chainFromRpc", () => {
  it("asks each rpc client for its network once", async () => {
    const rpc = { getNetwork: jest.fn(replies({ passphrase: Networks.TESTNET })) };
    expect(await StellarPlatform.chainFromRpc(rpc as any)).toEqual(["Testnet", "Stellar"]);
    expect(await StellarPlatform.chainFromRpc(rpc as any)).toEqual(["Testnet", "Stellar"]);
    expect(rpc.getNetwork).toHaveBeenCalledTimes(1);
  });

  it("asks again after a failed answer", async () => {
    const rpc = {
      getNetwork: jest.fn(replies(new Error("socket hang up"), { passphrase: Networks.TESTNET })),
    };
    await expect(StellarPlatform.chainFromRpc(rpc as any)).rejects.toThrow("socket hang up");
    expect(await StellarPlatform.chainFromRpc(rpc as any)).toEqual(["Testnet", "Stellar"]);
    expect(rpc.getNetwork).toHaveBeenCalledTimes(2);
  });
});

describe("StellarPlatform.simulateRead", () => {
  it("refuses a read for another network than the rpc serves", async () => {
    const rpc = {
      getNetwork: async () => ({ passphrase: Networks.PUBLIC }),
      simulateTransaction: jest.fn(),
    };
    await expect(
      StellarPlatform.simulateRead(rpc as any, "Testnet", CONTRACT, "decimals"),
    ).rejects.toThrow("Read of decimals is for Testnet, but the RPC serves Mainnet");
    expect(rpc.simulateTransaction).not.toHaveBeenCalled();
  });

  it("throws when a successful simulation has no result", async () => {
    const rpc = {
      getNetwork: async () => ({ passphrase: Networks.TESTNET }),
      simulateTransaction: async () => ({}),
    };
    await expect(
      StellarPlatform.simulateRead(rpc as any, "Testnet", CONTRACT, "decimals"),
    ).rejects.toThrow("Simulation of decimals returned no result");
  });
});

describe("StellarPlatform token reads", () => {
  const reads = (value: unknown) =>
    jest.spyOn(StellarPlatform, "simulateRead").mockResolvedValue(value);
  afterEach(() => jest.restoreAllMocks());

  it.each([5, null])("getBalance refuses a balance of %p", async (value) => {
    reads(value);
    await expect(
      StellarPlatform.getBalance("Testnet", "Stellar", {} as any, SOURCE, CONTRACT),
    ).rejects.toThrow(`Expected an i128 balance from ${CONTRACT}`);
  });

  it("getBalance refuses a secret seed as the wallet before any read", async () => {
    const read = reads(5n);
    const seed = Keypair.random().secret();
    const error = await StellarPlatform.getBalance(
      "Testnet",
      "Stellar",
      {} as any,
      seed,
      CONTRACT,
    ).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/^Invalid Stellar address/);
    expect((error as Error).message).not.toContain(seed);
    expect(read).not.toHaveBeenCalled();
  });

  it("getBalance returns an i128 balance", async () => {
    reads(5n);
    expect(
      await StellarPlatform.getBalance("Testnet", "Stellar", {} as any, SOURCE, CONTRACT),
    ).toBe(5n);
  });

  it.each([256, -1, "7"])("getDecimals refuses decimals of %p", async (value) => {
    reads(value);
    await expect(
      StellarPlatform.getDecimals("Testnet", "Stellar", {} as any, CONTRACT),
    ).rejects.toThrow(`Expected decimals from 0 to 255 from ${CONTRACT}`);
  });

  it("getDecimals returns decimals from 0 to 255", async () => {
    reads(7);
    expect(await StellarPlatform.getDecimals("Testnet", "Stellar", {} as any, CONTRACT)).toBe(7);
  });
});

describe("StellarPlatform.getRpc", () => {
  it("refuses a plain http rpc on Mainnet", () => {
    const { Stellar } = networkPlatformConfigs("Mainnet", "Stellar");
    const platform = new StellarPlatform("Mainnet", {
      Stellar: { ...Stellar!, rpc: "http://rpc.example.com" },
    });
    expect(() => platform.getRpc("Stellar")).toThrow(/insecure/);
  });

  it("allows the default plain http rpc on Devnet", () => {
    expect(new StellarPlatform("Devnet").getRpc("Stellar")).toBeInstanceOf(SorobanRpc.Server);
  });
});
