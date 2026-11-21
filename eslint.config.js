import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage', 'vectors', 'test/network', 'test/mainnet-blocks'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        window: 'readonly',
        document: 'readonly',
      },
    },
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'examples/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
