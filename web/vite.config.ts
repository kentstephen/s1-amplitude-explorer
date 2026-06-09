import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Project Pages site is served from /<repo>/.
  base: "/s1-amplitude-explorer/",
  plugins: [react()],
  worker: { format: "es" },
  server: { port: 5455, strictPort: true },
  // @developmentseed/geotiff worker pool uses top-level await.
  build: { target: "esnext" },
  // Pre-bundling rewrites `new URL("./worker.js", import.meta.url)` inside
  // `@developmentseed/geotiff/dist/pool/pool.js` to a path the optimizer
  // can't serve, so the decode worker pool fails to start and every tile
  // decode silently goes nowhere. Excluding keeps the original module URL
  // intact.
  optimizeDeps: {
    esbuildOptions: { target: "esnext" },
    exclude: ["@developmentseed/geotiff"],
  },
});
