// 最小化 ESLint 配置：先只拦"确定是 bug"的规则，不追求风格统一，避免历史代码大改。
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "runtime/dist/**", "release-portable/**", "node_modules/**", "**/*.js", "**/*.cjs", "**/*.mjs"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // 先关掉噪音大的规则，只保留"可能掩盖 bug"的项。
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      // 基线：先把"风格类"规则降为 warn，避免为历史代码制造大批无意义改动。
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
      "@typescript-eslint/unbound-method": "warn",
      "@typescript-eslint/no-base-to-string": "warn",
      "@typescript-eslint/restrict-template-expressions": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      "@typescript-eslint/prefer-promise-reject-errors": "warn",
      "no-control-regex": "warn",
      "no-useless-escape": "warn",
      "no-case-declarations": "warn",
      "prefer-const": "warn",
      "@typescript-eslint/no-redundant-type-constituents": "warn",
      "@typescript-eslint/only-throw-error": "warn",
      "@typescript-eslint/no-duplicate-type-constituents": "warn",
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-misused-promises": "warn",
      "@typescript-eslint/require-await": "off",
      "no-empty": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["tests/**", "**/*.test.ts", "**/*.test.tsx"],
    rules: { "@typescript-eslint/no-floating-promises": "off" },
  },
);
