// 构建：
//   宿主端 → Node ESM（lib/index.js、lib/agent.js，共用的代码拆进 lib/chunks/，两个入口拿到同一份运行时）
//   控制台 → DSH 的动态 client 模块（lib/client.js；React 由 DSH 网页外壳提供，不打进包里）
//   舞台页 → 独立的浏览器脚本（lib/stage.js，React 打进去；OBS 的浏览器源直接打开）
// --client：只重建控制台和舞台页。注意 DSH 会把控制台代码缓存在内存里，要重启 DSH 才生效
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('.', import.meta.url)));
import { mkdir, rm, readFile } from 'node:fs/promises';
const packageName = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8')).name;

const webOnly = process.argv.includes('--client');

if (!webOnly) {
  await rm('lib', { recursive: true, force: true });
  await mkdir('lib', { recursive: true });
  await build({
    entryPoints: { index: 'src/dsh/index.ts', agent: 'src/dsh/agent.ts' },
    outdir: 'lib',
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
    // ws 的可选原生加速包：没有就用纯 JS
    external: ['bufferutil', 'utf-8-validate', '@deepseek-ai/*', '@elysia/*'],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
}

await build({
  entryPoints: ['src/console/client.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  minify: true,
  banner: { js: `window.__ModuleLoader__.load({id:${JSON.stringify(packageName)},factory:(require)=>{var module={exports:{}};var exports=module.exports;` },
  footer: { js: 'return module.exports;}});' },
  define: { 'process.env.NODE_ENV': '"production"' },
});

await build({
  entryPoints: ['src/stage/main.tsx'],
  outfile: 'lib/stage.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});

console.log(webOnly ? 'built lib/client.js and lib/stage.js' : 'built lib/index.js, lib/agent.js, lib/client.js and lib/stage.js');
