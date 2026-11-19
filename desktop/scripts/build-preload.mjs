import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Electron's sandboxed preload uses a CommonJS runtime; author the bridge as ESM.
await build({
  entryPoints: [fileURLToPath(new URL('../preload.js', import.meta.url))],
  outfile: fileURLToPath(new URL('../preload.bundle.cjs', import.meta.url)),
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node22',
});

// Tagsmith's read-only entry (embedded tags and MBIDs), bundled with its pure-JS tag parser into one
// file that ships beside main.js. The write path (node-taglib-sharp, native) is not reachable from it.
await build({
  entryPoints: [fileURLToPath(new URL('../../tagsmith/src/read.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../tagsmith-read.js', import.meta.url)),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['node-taglib-sharp'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url)" },
});
