import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // Bundle everything (incl. the TS-source-only @live-ai/shared) so the runtime image needs no node_modules.
  noExternal: [/.*/],
  // CJS deps bundled into ESM still call require() for Node built-ins.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
