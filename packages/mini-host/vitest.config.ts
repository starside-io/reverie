import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Core is consumed from source in this repo, so a test never waits on a build.
// The published entry points at dist, which is what the MCP server runs from.
const coreSrc = fileURLToPath(new URL("../core/src", import.meta.url));
const transcriptsSrc = fileURLToPath(new URL("../connector-transcripts/src", import.meta.url));
const markdownSrc = fileURLToPath(new URL("../adapter-markdown/src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@reverie\/core$/, replacement: `${coreSrc}/index.ts` },
      { find: /^@reverie\/core\/(.*)$/, replacement: `${coreSrc}/$1` },
      { find: /^@reverie\/connector-transcripts$/, replacement: `${transcriptsSrc}/index.ts` },
      { find: /^@reverie\/adapter-markdown$/, replacement: `${markdownSrc}/index.ts` },
    ],
  },
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // A child process MCP server starts through tsx and Prisma: give it room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
