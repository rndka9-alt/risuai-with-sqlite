'use strict';

const esbuild = require('esbuild');

esbuild.buildSync({
  entryPoints: ['src/server/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/server.js',
  target: 'node18',
  external: ['better-sqlite3'],
  sourcemap: true,
});

console.log('Build complete');
