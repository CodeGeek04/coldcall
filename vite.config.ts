import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // The browser only talks to the Node server, which holds the API keys.
      "/ws": { target: "http://127.0.0.1:8787", ws: true },
      "/api": { target: "http://127.0.0.1:8787" },
    },
  },
  build: { outDir: "../dist/web", emptyOutDir: true },
});
