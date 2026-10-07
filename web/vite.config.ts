import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

// `MOCK_API=1 vite` serves /api from an in-memory fixture so the UI runs
// without the daemon. Otherwise /api goes to `agent-workflows ui`.
function mockApiPlugin(): Plugin {
  return {
    name: "guided-review-mock-api",
    async configureServer(server) {
      const { mockApi } = await import("./src/dev/mock-api.ts");
      const handler = mockApi();
      server.middlewares.use((req, res, next) => {
        handler(req, res, next).catch(next);
      });
    },
  };
}

const mock = process.env.MOCK_API === "1";

export default defineConfig({
  plugins: [react(), ...(mock ? [mockApiPlugin()] : [])],
  server: {
    port: 5173,
    // The review server accepts only its own Host and Origin, so the proxy
    // rewrites Host and drops the dev server's Origin.
    proxy: mock
      ? undefined
      : {
          "/api": {
            target: "http://127.0.0.1:4773",
            changeOrigin: true,
            configure: (proxy) => {
              proxy.on("proxyReq", (req) => req.removeHeader("origin"));
            },
          },
        },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
