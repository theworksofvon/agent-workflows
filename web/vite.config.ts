import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The review server accepts only its own Host and Origin, so the proxy
    // rewrites Host and drops the dev server's Origin.
    proxy: {
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
});
