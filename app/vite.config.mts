import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import electron from "vite-plugin-electron/simple"
import path from "node:path"
import { builtinModules } from "node:module"
import { readFileSync } from "node:fs"

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> }

// Node-side dependencies stay external: electron-builder ships node_modules,
// and bundling them (openai, ws) buys nothing.
const external = [
  "electron",
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  ...Object.keys(pkg.dependencies)
]

export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        // The speech worker is its own entry: it runs in an Electron utility process.
        entry: { main: "electron/main.ts", "asr-worker": "electron/asr-worker.ts" },
        vite: { build: { outDir: "dist-electron", rolldownOptions: { external } } }
      },
      preload: {
        input: "electron/preload.ts",
        vite: { build: { outDir: "dist-electron", rolldownOptions: { external } } }
      }
    })
  ],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5175, strictPort: true },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@shared": path.resolve(import.meta.dirname, "shared")
    }
  }
})
