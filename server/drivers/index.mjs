import * as agy from "./agy.mjs";
import * as claude from "./claude.mjs";
import * as codex from "./codex.mjs";
import * as direct from "./direct.mjs";
import * as dsh from "./dsh.mjs";

export const DRIVERS = {
  agy,
  dsh,
  claude,
  codex,
  direct,
};

export function getDriver(driverId) {
  return DRIVERS[driverId] || null;
}

export function detectAllDrivers({ pluginRoot, scanDesktop = true, customProfiles = [] } = {}) {
  return [
    agy.detect({ pluginRoot }),
    dsh.detect({ pluginRoot, scanDesktop }),
    claude.detect({ pluginRoot }),
    codex.detect({ pluginRoot }),
    direct.detect({ customProfiles }),
  ];
}
