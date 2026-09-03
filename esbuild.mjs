import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  logLevel: 'info',
};

const builds = [
  {
    ...common,
    entryPoints: ['src/extension/extension.ts'],
    outfile: 'dist/extension.js',
    format: 'cjs',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: ['src/mcp/server.ts'],
    outfile: 'dist/mcp.js',
    format: 'cjs',
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    // The sidebar webview. platform:'browser' is load-bearing: src/core is
    // shared with the extension, and something there reaching node:fs would
    // otherwise fail as a blank panel at runtime instead of a build error.
    ...common,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
  },
];

if (watch) {
  for (const b of builds) {
    const ctx = await esbuild.context(b);
    await ctx.watch();
  }
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
