import type { Network } from "@wormhole-foundation/sdk-connect";
import { ChainContext } from "@wormhole-foundation/sdk-connect";
import type { StellarChains } from "./types.js";

export class StellarChain<
  N extends Network = Network,
  C extends StellarChains = StellarChains,
> extends ChainContext<N, C> {}
