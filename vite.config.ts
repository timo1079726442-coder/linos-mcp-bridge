import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
    target: "chrome120",
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    setupFiles: ["src/test-setup.ts"],
  },
});
