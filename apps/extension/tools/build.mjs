import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'src');
const staticDir = path.join(root, 'static');
const distDir = path.join(root, 'dist');

const watch = process.argv.includes('--watch');

fs.mkdirSync(distDir, { recursive: true });

function copyStaticEntry(src, dest, label) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      copyStaticEntry(path.join(src, child), path.join(dest, child), `${label}/${child}`);
    }
    return;
  }

  try {
    fs.copyFileSync(src, dest);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'EPERM') {
      // eslint-disable-next-line no-console
      console.warn(`[extension build] skip locked static file: ${label}`);
      return;
    }
    throw err;
  }
}

for (const file of fs.readdirSync(staticDir)) {
  copyStaticEntry(path.join(staticDir, file), path.join(distDir, file), file);
}

const common = {
  bundle: true,
  sourcemap: true,
  target: ['chrome120', 'edge120'],
  logLevel: 'info',
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
};

const builds = [
  esbuild.build({
    ...common,
    entryPoints: {
      background: path.join(srcDir, 'background.ts'),
    },
    format: 'iife',
    outfile: path.join(distDir, 'background.js'),
  }),
  esbuild.build({
    ...common,
    entryPoints: {
      content: path.join(srcDir, 'content.ts'),
    },
    format: 'iife',
    outfile: path.join(distDir, 'content.js'),
  }),
  esbuild.build({
    ...common,
    entryPoints: {
      popup: path.join(srcDir, 'popup.ts'),
    },
    format: 'iife',
    outfile: path.join(distDir, 'popup.js'),
  }),
  esbuild.build({
    ...common,
    entryPoints: {
      options: path.join(srcDir, 'options.ts'),
    },
    format: 'iife',
    outfile: path.join(distDir, 'options.js'),
  }),
];

if (!watch) {
  await Promise.all(builds);
  process.exit(0);
}

const ctx = await esbuild.context({
  ...common,
  entryPoints: {
    background: path.join(srcDir, 'background.ts'),
    content: path.join(srcDir, 'content.ts'),
    popup: path.join(srcDir, 'popup.ts'),
    options: path.join(srcDir, 'options.ts'),
  },
  format: 'iife',
  outdir: distDir,
});
await ctx.watch();
// eslint-disable-next-line no-console
console.log('[extension] watching...');
