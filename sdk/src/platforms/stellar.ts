import { applyChainsConfigConfigOverrides } from "@wormhole-foundation/sdk-connect";
import { PlatformDefinition } from "../index.js";
import * as _stellar from "@wormhole-foundation/sdk-stellar";

export const stellar: PlatformDefinition<typeof _stellar._platform> = {
  Address: _stellar.StellarAddress,
  Platform: _stellar.StellarPlatform,
  getSigner: _stellar.getStellarSigner,
  protocols: {
    WormholeCore: () => import("@wormhole-foundation/sdk-stellar-core"),
  },
  getChain: (network, chain, overrides?) =>
    new _stellar.StellarChain(
      chain,
      new _stellar.StellarPlatform(
        network,
        applyChainsConfigConfigOverrides(network, _stellar._platform, {
          [chain]: overrides,
        }),
      ),
    ),
};
export default stellar;
