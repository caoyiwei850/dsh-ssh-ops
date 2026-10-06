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
    // Flat config's default file set is **/*.js only — without this block the
    // client JSX was never linted, and a ReferenceError (renamed binding)
    // shipped in 0.3.16 (#27) that no-undef would have caught.
    files: ["src/client/**/*.jsx"],
    languageOptions: {
      parserOptions: { ecmaVersion: 2024, sourceType: "module", ecmaFeatures: { jsx: true } }
    },
    rules: {
      // esbuild's classic JSX transform emits React.createElement, so the
      // `import * as React` is load-bearing even where source-level JSX never
      // references the identifier.
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^React$", caughtErrors: "none" }]
    }
  },
  {
    files: ["test/**", "scripts/**", "*.mjs"],
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none", varsIgnorePattern: "^_" }]
    }
  }
];
