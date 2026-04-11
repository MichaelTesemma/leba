import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  publicDir: false,
  build: {
    outDir: "public",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Code splitting via dynamic imports — route-level chunks
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("artplayer")) return "artplayer";
            if (id.includes("react") || id.includes("react-dom") || id.includes("react-router")) return "react-vendor";
            if (id.includes("webtorrent")) return "webtorrent";
          }
        },
      },
    },
  },
  optimizeDeps: {
    include: ["artplayer", "react-router-dom", "uqr"],
  },
});
