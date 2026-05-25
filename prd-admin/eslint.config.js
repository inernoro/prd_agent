import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // 现有代码里 any 较多：先降级为 warn，避免阻断开发；后续可逐步收敛
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // 第三方 vendor 目录（reactbits 等 MIT 库的 copy-paste 源码）保持原样，
    // 不强制项目级 lint 规则；如需修改请走 wrapper，详见 reactbits/LICENSE.md。
    files: ['src/components/reactbits/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'react-hooks/exhaustive-deps': 'off',
    },
  },
  {
    ignores: ['dist', 'node_modules'],
  },
];
