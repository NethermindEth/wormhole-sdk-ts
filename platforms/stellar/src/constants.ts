import { Asset } from "@stellar/stellar-sdk";
import { nativeChainIds } from "@wormhole-foundation/sdk-connect";
import type { Network } from "@wormhole-foundation/sdk-connect";
import { _platform } from "./types.js";

/** Stellar network passphrase for a Wormhole network (sourced from sdk-base). */
export function stellarNetworkPassphrase(network: Network): string {
  const passphrase = nativeChainIds.networkChainToNativeChainId.get(network, _platform);
  if (typeof passphrase !== "string")
    throw new Error(`No Stellar network passphrase for ${network}`);
  return passphrase;
}

/** Contract id (`C…`) of the native XLM Stellar Asset Contract for a network. */
export function nativeSacId(network: Network): string {
  return Asset.native().contractId(stellarNetworkPassphrase(network));
}
