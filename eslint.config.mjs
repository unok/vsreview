import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.scratch/**'] },
  js.configs.recommended,
  { rules: { curly: ['error', 'all'] } },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({ ...config, files: ['**/*.ts', '**/*.mts'] })),
  {
    files: ['**/*.ts', '**/*.mts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
  },
);
