import react from "@vitejs/plugin-react";
import stylexPlugin from "@stylexjs/rollup-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), stylexPlugin({ fileName: "atomic.css", useCSSLayers: true })],
  server: {
    proxy: {
      "/agent": "http://127.0.0.1:8787",
      "/api": "http://127.0.0.1:8787",
    },
  },
});
