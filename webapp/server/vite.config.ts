// Bundles the contribution server and book-admin for Node 20 on the VPS (which cannot run
// TypeScript): npm run server:build → server/dist/{server,book-admin}.mjs plus the rules module.
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    ssr: true,
    target: "node20",
    outDir: "server/dist",
    emptyOutDir: true,
    rollupOptions: {
      input: { server: "server/main.ts", "book-admin": "server/admin.ts" },
      output: { format: "es", entryFileNames: "[name].mjs" },
    },
  },
});
