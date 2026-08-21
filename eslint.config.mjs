import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "**/.turbo/**", "**/generated/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error"
    }
  },
  {
    // DC-5 / Phase 2 "no float money" guard: money amounts are bigint minor units only.
    files: [
      "packages/shared/src/money/**",
      "packages/shared/src/ledger/**",
      "apps/api/src/modules/ledger/**",
      "apps/api/src/modules/payments/**",
      "apps/api/src/modules/payouts/**",
      "apps/api/src/modules/reconciliation/**"
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSTypeReference[typeName.name='number']",
          message: "Money modules must not use `number` for amounts — use bigint minor units (DC-5)."
        }
      ]
    }
  }
);
