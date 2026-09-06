/**
 * Flat ESLint config. Kept deliberately lean: this codebase predates any
 * linter, so the goal is catching real defects (unused vars, dangling
 * promises, accidental globals) — not imposing a house style.
 */
import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    ignores: ["lib/**", "node_modules/**", "release/**", "coverage/**"]
  },
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-async-promise-executor": "error",
      // Intentional teardown catches (`try { x.end() } catch {}`) are the
      // established convention across the codebase.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Terminal output matching uses ESC/BEL control characters by design.
      "no-control-regex": "off",
      "preserve-caught-error": "off",
      "require-atomic-updates": "off"
    }
  },
  {
    files: ["test/**", "scripts/**", "*.mjs"],
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none", varsIgnorePattern: "^_" }]
    }
  }
];
