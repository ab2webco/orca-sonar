import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import { defineConfig } from 'eslint/config'

export default defineConfig(
  {
    ignores: ['node_modules/', 'coverage/']
  },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'error',
      'no-debugger': 'error'
    }
  },
  {
    // node:test registers suites synchronously and runs them itself; its return value is not work to await.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off'
    }
  }
)
