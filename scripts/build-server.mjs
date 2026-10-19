import { build } from 'esbuild';

/**
 * Bundles the Hono worker (server + @Mind Flayer/auth) into a single ESM module
 * that Sites uploads as the Worker entrypoint.
 */
await build({
  entryPoints: ['server/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: 'build/worker.js',
  minify: true,
  legalComments: 'none',
  conditions: ['workerd', 'worker', 'browser'],
  logLevel: 'info',
});

console.log('[build-server] wrote build/worker.js');
