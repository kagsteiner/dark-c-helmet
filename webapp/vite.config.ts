import { defineConfig } from "vite";

// The engine uses threads (SharedArrayBuffer), which browsers only allow on
// cross-origin isolated pages. nginx on the VPS sends the same two headers.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  base: "./", // relative paths: the build works in the server root or in a subfolder
  server: {
    headers: isolation,
    // The contribution server (npm run server) as on the VPS, where nginx maps /chess/api/.
    proxy: { "/api/": { target: "http://127.0.0.1:3060", rewrite: (p) => p.replace(/^\/api/, "") } },
  },
  preview: { headers: isolation },
  worker: { format: "es" },
  build: {
    rollupOptions: {
      input: { main: "index.html", "engine-test": "engine-test.html" },
    },
  },
});
