import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: ['**/*.ts'],
  })),
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: './tsconfig.test.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Regression guard for the i18n migration: raw CJK string/template
    // literals must go through `t()` (see src/i18n/index.ts) instead of
    // being hardcoded in source. `src/i18n/locales/**` holds the actual
    // Japanese resource strings and is exempt; `tests/**` legitimately
    // asserts against translated (Japanese) output values; and
    // `scripts/log-preview.ts` is a local dev-only preview tool that
    // renders synthetic dummy embeds and is not user-facing production
    // output, so it is exempt like test fixtures. `scripts/deploy-commands.ts`
    // is real composition-root code and stays covered.
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    ignores: ['src/i18n/locales/**', 'tests/**', 'scripts/log-preview.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'Literal[value=/[\\u3040-\\u30FF\\u4E00-\\u9FFF\\u3000-\\u303F\\uFF00-\\uFFEF]/u]:not(TSLiteralType > Literal)',
          message:
            'Raw Japanese (CJK) string literals are not allowed outside src/i18n/locales/**. Use t() from src/i18n/index.ts instead.',
        },
        {
          selector:
            'TemplateElement[value.raw=/[\\u3040-\\u30FF\\u4E00-\\u9FFF\\u3000-\\u303F\\uFF00-\\uFFEF]/u]',
          message:
            'Raw Japanese (CJK) text in template literals is not allowed outside src/i18n/locales/**. Use t() from src/i18n/index.ts instead.',
        },
      ],
    },
  },
  prettier,
);
