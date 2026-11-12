/** Build only the browser module. No services, model calls, or package installation. */
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
process.chdir(fileURLToPath(new URL('.',import.meta.url)))
const name = JSON.parse(await readFile(new URL('./package.json',import.meta.url),'utf8')).name
await build({
  entryPoints:['src/console/client.tsx'],outfile:'lib/client.js',bundle:true,
  platform:'browser',format:'cjs',target:'es2022',jsx:'automatic',
  external:['react','react/jsx-runtime'],minify:true,
  banner:{js:`window.__ModuleLoader__.load({id:${JSON.stringify(name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;`},
  footer:{js:'return module.exports;}});'},
  define:{'process.env.NODE_ENV':'"production"'},
})
console.log('built lib/client.js')
