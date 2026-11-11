import { defineConfig } from "vitest/config";
import * as path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      // Bare "vscode" -> minimal runtime mock, so modules importing vscode can be unit tested.
      vscode: path.resolve(__dirname, "tests/__mocks__/vscode.ts"),
      // git submodule, consumed as TypeScript source (same mapping as tsconfig paths / esbuild alias)
      "opengr8on-node/client": path.resolve(__dirname, "lib/opengr8on-node/src/client-entry.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
