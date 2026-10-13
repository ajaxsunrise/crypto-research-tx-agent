import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/agent": "http://127.0.0.1:8787",
      "/api": "http://127.0.0.1:8787",
    },
  },
});
