import { builtinModules } from "node:module";
import { defineConfig } from "vite";

/**
 * The command-line client: cli/src and the operations it shares with the
 * plugin, bundled into the one file that `npx obsidian-bilinear` runs.
 */
export default defineConfig({
  build: {
    lib: { entry: "../cli/src/bin.ts", formats: ["es"], fileName: () => "bilinear.js" },
    outDir: "../cli/dist",
    emptyOutDir: true,
    minify: false,
    target: "node20",
    rollupOptions: {
      external: [...builtinModules, /^node:/],
      output: { banner: "#!/usr/bin/env node" },
    },
  },
});
