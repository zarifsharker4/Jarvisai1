import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: false });
  if (res.status !== 0) {
    console.error(`[build] ${cmd} ${args.join(' ')} failed with ${res.status}`);
    process.exit(res.status ?? 1);
  }
}

mkdirSync('build', { recursive: true });

// 1. Frontend (React + Vite) -> build/dist
run('node', ['./node_modules/vite/bin/vite.js', 'build']);

// 2. Worker -> build/worker.js
run('node', ['scripts/build-server.mjs']);

// 3. Deploy manifest for Sites
const manifest = {
  entrypoint: 'index.js',
  compatibilityDate: '2026-10-19',
  modules: [{ name: 'index.js', type: 'esm', path: './worker.js' }],
  assetsDirectory: './dist',
  spa: true,
};
writeFileSync('build/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log('[build] wrote build/manifest.json');
