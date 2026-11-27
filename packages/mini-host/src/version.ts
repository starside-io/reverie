import { readFileSync } from "node:fs";

/**
 * This build's version, from the package it ships in. Every package moves in
 * lockstep with the plugin, so it is the plugin's version too. Lifted from
 * Fellowship's version.ts.
 *
 * Read from ../package.json beside src/ or dist/, which is
 * packages/mini-host/package.json in a checkout and
 * node_modules/@reverie/mini-host/package.json in the npm package.
 */
export const REVERIE_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
