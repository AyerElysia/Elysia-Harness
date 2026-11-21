/** Build only the isolated web client; no call, profile change, or network. */
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
process.chdir(fileURLToPath(new URL('.', import.meta.url)))
const { name } = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
await build({
  entryPoints: ['src/client/index.tsx'], outfile: 'lib/client.js', bundle: true,
  platform: 'browser', format: 'cjs', target: 'es2022', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'], minify: true,
  banner: { js: 'window.__ModuleLoader__.load({id:' + JSON.stringify(name) + ',factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
  define: { 'process.env.NODE_ENV': '"production"' },
})
