/// <reference path="../../platforms/stellar/src/index.ts" />
import type { PlatformDefinition } from "./index.js";
const stellar = async (): Promise<PlatformDefinition<"Stellar">> =>
  (await import("./platforms/stellar.js")).default;
export default stellar;
