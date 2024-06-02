import { build } from 'esbuild';

build({
    entryPoints: ['src/index.js'],
    outfile: 'dist.js',
    bundle: true,
    minify: true,
    platform: 'node',
    external: ['electron'],
});
