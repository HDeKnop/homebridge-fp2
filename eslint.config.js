import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'homebridge-ui/public/**'],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['src/**/*.{ts,js}', 'test/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'prefer-const': 'warn',
      'prefer-arrow-callback': 'warn',
      'dot-notation': 'warn',
      'no-console': 'warn',
      eqeqeq: ['error', 'always'],
    },
  },

  {
    files: ['test/**/*.ts'],
    rules: {
      'prefer-arrow-callback': 'off',
    },
  },

  prettierConfig
);
