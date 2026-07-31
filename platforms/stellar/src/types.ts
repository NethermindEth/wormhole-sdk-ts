import type { PlatformToChains, UniversalOrNative } from "@wormhole-foundation/sdk-connect";

/** Runtime value for the Stellar Platform */
export const _platform: "Stellar" = "Stellar";

/** Type for the Stellar Platform */
export type StellarPlatformType = typeof _platform;

export type StellarChains = PlatformToChains<StellarPlatformType>;
export type UniversalOrStellar = UniversalOrNative<StellarChains>;
export type AnyStellarAddress = UniversalOrStellar | string | Uint8Array;
