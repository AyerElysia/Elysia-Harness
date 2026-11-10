// Build the Ayla channel's browser half into one dynamic client module.
// DSH's web shell provides React through the module table, so it stays external.
//
//   node build.mjs          rebuild lib/client.js
//
// The Host caches client bundles in memory: restart dsh web after rebuilding.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile } from 'node:fs/promises'

process.chdir(fileURLToPath(new URL('.', import.meta.url)))
const packageName = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8')).name

await mkdir('lib', { recursive: true })
await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  minify: true,
  sourcemap: true,
  banner: {
    js: `window.__ModuleLoader__.load({id:${JSON.stringify(packageName)},factory:(require)=>{var module={exports:{}};var exports=module.exports;`,
  },
  footer: { js: 'return module.exports;}});' },
  define: { 'process.env.NODE_ENV': '"production"' },
})

console.log('built lib/client.js')
