import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Core and the mini-host are consumed from source, as in the mini-host's own
// tests, so a test never waits on a build.
const coreSrc = fileURLToPath(new URL("../core/src", import.meta.url));
const hostSrc = fileURLToPath(new URL("../mini-host/src", import.meta.url));
const transcriptsSrc = fileURLToPath(new URL("../connector-transcripts/src", import.meta.url));
const markdownSrc = fileURLToPath(new URL("../adapter-markdown/src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@reverie\/core$/, replacement: `${coreSrc}/index.ts` },
      { find: /^@reverie\/core\/(.*)$/, replacement: `${coreSrc}/$1` },
      { find: /^@reverie\/mini-host$/, replacement: `${hostSrc}/index.ts` },
      { find: /^@reverie\/connector-transcripts$/, replacement: `${transcriptsSrc}/index.ts` },
      { find: /^@reverie\/adapter-markdown$/, replacement: `${markdownSrc}/index.ts` },
    ],
  },
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
