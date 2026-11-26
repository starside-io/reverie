import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The standalone shell.
 *
 * In development this serves the SPA on 4330 and proxies the paths the host
 * owns to a host started separately, so the UI talks to the same POST /rpc it
 * will talk to in production and never to a mock. The build goes to dist,
 * which the host serves.
 *
 * The host refuses a write whose Origin is not its own. A request from this
 * dev page carries Origin http://localhost:4330, so the proxy rewrites that
 * one origin, and only that one, to the host's. A page on any other origin
 * keeps its own Origin header through the proxy and is refused by the host.
 */

const DEV_PORT = 4330;
const hostPort = Number(process.env["REVERIE_PORT"]) || 4329;
const target = `http://127.0.0.1:${hostPort}`;
const devOrigins = new Set([`http://localhost:${DEV_PORT}`, `http://127.0.0.1:${DEV_PORT}`]);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: /^@\/(.*)$/,
        replacement: `${fileURLToPath(new URL("./src", import.meta.url))}/$1`,
      },
    ],
  },
  server: {
    port: DEV_PORT,
    strictPort: true,
    host: "127.0.0.1",
    proxy: Object.fromEntries(
      ["/rpc", "/host", "/health"].map((path) => [
        path,
        {
          target,
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on("proxyReq", (request, incoming) => {
              const origin = incoming.headers.origin;
              if (typeof origin === "string" && devOrigins.has(origin)) {
                request.setHeader("origin", target);
              }
            });
          },
        },
      ]),
    ),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
