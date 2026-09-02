import { registerProtocol } from "@wormhole-foundation/sdk-connect";
import { _platform } from "@wormhole-foundation/sdk-stellar";
import { StellarWormholeCore } from "./core.js";

registerProtocol(_platform, "WormholeCore", StellarWormholeCore);

export * from "./core.js";
