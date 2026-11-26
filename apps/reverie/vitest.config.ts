import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The workspace packages are consumed from source, so a test never waits on
// a build.
const coreSrc = fileURLToPath(new URL("../../packages/core/src", import.meta.url));
const hostSrc = fileURLToPath(new URL("../../packages/mini-host/src", import.meta.url));
const transcriptsSrc = fileURLToPath(new URL("../../packages/connector-transcripts/src", import.meta.url));
const markdownSrc = fileURLToPath(new URL("../../packages/adapter-markdown/src", import.meta.url));

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
