import { build } from 'esbuild';
import { bundleOptions } from './esbuild.options.mjs';
await build({ ...bundleOptions, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', sourcemap: true });
