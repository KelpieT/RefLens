const esbuild = require('esbuild');
const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['./src/extension.ts'],
  bundle: true,
  outfile: './dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node16',
  sourcemap: true,
  minify: !isWatch,
  logLevel: 'info',
};

if (isWatch) {
  esbuild.context(options).then(ctx => ctx.watch());
} else {
  esbuild.build(options).catch(() => process.exit(1));
}
