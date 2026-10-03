import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
  resolve: { alias: { "@shared": path.resolve(import.meta.dirname, "shared") } }
})
