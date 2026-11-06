import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { defineConfig } from "vite";

const backend = process.env.TWINMIND_BACKEND ?? "http://127.0.0.1:8099";

export default defineConfig({
  // Relative asset URLs: the app is served under /api/hassio_ingress/<token>/.
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: "@shared", replacement: path.resolve(import.meta.dirname, "../server/src") },
      { find: "@", replacement: path.resolve(import.meta.dirname, "src") },
      // Exact match only. See src/lib/shims/ansi-to-react.ts (CommonJS default-export interop).
      { find: /^ansi-to-react$/, replacement: path.resolve(import.meta.dirname, "src/lib/shims/ansi-to-react.ts") },
    ],
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    proxy: {
      "/api": { target: backend, ws: true, changeOrigin: false },
    },
  },
});
