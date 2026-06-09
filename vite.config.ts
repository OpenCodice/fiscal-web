import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";

// En dev: vite sirve el frontend (5173) y proxya /api al Worker (wrangler dev, 8787).
// En build: produce ./dist, que el Worker sirve vía el binding ASSETS.
export default defineConfig({
  plugins: [preact(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
