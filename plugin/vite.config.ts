import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import vue from "@vitejs/plugin-vue";
import { defineConfig, type Plugin } from "vite";

/**
 * Obsidian loads main.js, styles.css and manifest.json from one folder. The
 * manifest lives at the repository root, where Obsidian's plugin tooling
 * (the community list, BRAT) looks for it.
 */
function manifest(): Plugin {
  return {
    name: "bilinear-manifest",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "manifest.json", source: readFileSync("../manifest.json", "utf8") });
    },
  };
}

export default defineConfig(({ mode }) => {
  const production = mode === "production";
  return {
    plugins: [vue(), manifest()],
    define: {
      "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development"),
      __VUE_OPTIONS_API__: "false",
      __VUE_PROD_DEVTOOLS__: "false",
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
    },
    build: {
      lib: { entry: "src/main.ts", formats: ["cjs"], fileName: () => "main.js", cssFileName: "styles" },
      outDir: "dist",
      emptyOutDir: false,
      minify: production,
      sourcemap: production ? false : "inline",
      target: "es2022",
      rollupOptions: {
        external: ["obsidian", "electron", /^@codemirror\//, /^@lezer\//, ...builtinModules],
        output: { exports: "default" },
      },
    },
    test: {
      include: ["tests/**/*.test.ts"],
      environment: "node",
    },
  };
});
