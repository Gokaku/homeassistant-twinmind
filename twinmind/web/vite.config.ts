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
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@shared": path.resolve(import.meta.dirname, "../server/src"),
    },
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
