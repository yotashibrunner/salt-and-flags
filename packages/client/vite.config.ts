import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Multi-page app: the chart (index.html) and the market panel (market.html).
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        market: fileURLToPath(new URL("./market.html", import.meta.url)),
        pillage: fileURLToPath(new URL("./pillage.html", import.meta.url)),
      },
    },
  },
});
