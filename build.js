import esbuild from 'esbuild';

// Client bundle (browser IIFE)
esbuild.buildSync({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'iife',
  outfile: 'dist/client.js',
  target: 'es2018',
});

// Server bundle (Node.js ESM)
esbuild.buildSync({
  entryPoints: ['src/server/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/server.js',
  target: 'node18',
  external: ['better-sqlite3', 'stream-json', 'stream-chain'],
  sourcemap: true,
});

console.log('Build complete');
