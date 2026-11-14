// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['eslint.config.mjs', 'dist/**', 'node_modules/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      /*
       * ⚠️ `no-explicit-any` — XATO, ogohlantirish emas. `any` tip
       * tizimining butun foydasini bekor qiladi va u bir marta
       * kirgandan keyin kod bo'ylab tarqaladi.
       */
      '@typescript-eslint/no-explicit-any': 'error',
      /*
       * ⚠️ `no-floating-promises` ham XATO: kutilmagan `Promise`
       * xatosi Node'da JIM yutiladi (yoki jarayonni yiqitadi) va
       * uning sababi butunlay boshqa joyda ko'rinadi.
       */
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/require-await': 'warn',
      // Ishlatilmagan o'zgaruvchi — `_` prefiksi bilan ataylab qoldirilgani bundan mustasno.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
