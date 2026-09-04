import { defineConfig } from 'tsdown'

/** Build the standalone Host entry without reaching into a Harness checkout. */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: '.',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    neverBundle: ['@deepseek-ai/schemastery'],
  },
})
