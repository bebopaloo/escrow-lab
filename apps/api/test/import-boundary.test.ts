import { resolve } from "node:path";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
// The linted files do not exist on disk, so the test turns type information off.
const eslint = new ESLint({
  cwd: root,
  overrideConfig: [
    tseslint.configs.disableTypeChecked,
    { languageOptions: { parserOptions: { projectService: false } } },
  ],
});

async function boundaryMessages(code: string, file: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: resolve(root, file) });
  return (result?.messages ?? []).filter((m) => m.ruleId === "boundary/import-boundary").length;
}

describe("module import boundary", () => {
  it("rejects an inner file of a module from outside its folder", async () => {
    const count = await boundaryMessages(
      'import "../modules/ledger/store.ts";\n',
      "apps/api/src/routes/example.ts",
    );
    expect(count).toBe(1);
  });

  it("allows the index.ts of a module and its own inner files", async () => {
    const count = await boundaryMessages(
      'import "./index.ts";\nimport "./store.ts";\n',
      "apps/api/src/modules/ledger/service.ts",
    );
    expect(count).toBe(0);
  });
});

describe("adapter import boundary", () => {
  it("rejects an inner file of an adapter and allows its index.ts", async () => {
    const file = "apps/api/src/routes/example.ts";
    expect(await boundaryMessages('import "../adapters/chain/fake.ts";\n', file)).toBe(1);
    expect(await boundaryMessages('import "../adapters/chain/index.ts";\n', file)).toBe(0);
  });
});

describe("sibling module boundary", () => {
  it("rejects an inner file of a sibling module and allows its index.ts", async () => {
    const file = "apps/api/src/modules/deals/service.ts";
    expect(await boundaryMessages('import "../ledger/store.ts";\n', file)).toBe(1);
    expect(await boundaryMessages('import "../ledger/index.ts";\n', file)).toBe(0);
  });
});

describe("boundary edge cases", () => {
  it("rejects an inner file of an adapter from a sibling adapter", async () => {
    const file = "apps/api/src/adapters/payment-rail/rail.ts";
    expect(await boundaryMessages('import "../chain/fake.ts";\n', file)).toBe(1);
    expect(await boundaryMessages('import "../chain/index.ts";\n', file)).toBe(0);
  });

  it("rejects a dynamic import of an inner file", async () => {
    const file = "apps/api/src/routes/example.ts";
    expect(await boundaryMessages('await import("../modules/ledger/store.ts");\n', file)).toBe(1);
    expect(await boundaryMessages('await import("../modules/ledger/index.ts");\n', file)).toBe(0);
  });

  it("rejects a deep path into a sibling module at any depth", async () => {
    const deep = "apps/api/src/modules/deals/handlers/x.ts";
    expect(await boundaryMessages('import "../../ledger/store.ts";\n', deep)).toBe(1);
    const flat = "apps/api/src/modules/deals/service.ts";
    expect(await boundaryMessages('import "../ledger/sub/x.ts";\n', flat)).toBe(1);
  });

  it("allows an import between two sub-folders of the same module", async () => {
    const file = "apps/api/src/modules/deals/handlers/create.ts";
    expect(await boundaryMessages('import "../store/x.ts";\n', file)).toBe(0);
  });
});
