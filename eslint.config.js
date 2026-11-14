import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";
import boundary from "./eslint-rules/import-boundary.js";

export default defineConfig(
  {
    ignores: [
      "**/node_modules/",
      "**/dist/",
      "**/coverage/",
      "playwright-report/",
      "test-results/",
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: globals.node,
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    // Code may reach a module or an adapter through its index.ts only.
    files: ["apps/api/**/*.ts"],
    plugins: { boundary },
    rules: { "boundary/import-boundary": "error" },
  },
  {
    // Only test code can import a fake with a failure script.
    files: ["apps/api/src/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/chain", "**/chain/index.ts", "**/chain/fake.ts"],
              importNames: ["createFakeChain"],
              message: "Only test code can import createFakeChain.",
            },
            {
              group: ["**/payment-rail", "**/payment-rail/index.ts", "**/payment-rail/fake.ts"],
              importNames: ["createFakePaymentRail"],
              message: "Only test code can import createFakePaymentRail.",
            },
            {
              group: ["**/fake-core", "**/fake-core.ts"],
              importNames: ["createFakeCore"],
              message: "Only the two fake adapters and test code can import createFakeCore.",
            },
          ],
        },
      ],
    },
  },
  {
    // The two fakes build on the shared core.
    files: ["apps/api/src/adapters/chain/fake.ts", "apps/api/src/adapters/payment-rail/fake.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
