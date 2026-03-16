'use strict';

const esbuild = require('esbuild');

// Client bundle (browser IIFE)
esbuild.buildSync({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'iife',
  outfile: 'dist/client.js',
  target: 'es2018',
});

// Server bundle (Node.js CJS)
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
