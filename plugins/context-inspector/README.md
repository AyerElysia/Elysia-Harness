# Context inspector

Read the latest immutable, pre-adapter model request from the selected DSH Web
session. A removable Conversation view exposes system/developer input, every
message, tool definitions, and the complete archived JSON.

The Host uses native authenticated Remote calls with session resource checks;
no public HTTP channel or alternate token is introduced. Full input remains
private to the session's authorized caller. Each page is pinned to one request,
bounded in bytes, and cut only at UTF-8 boundaries. The Client marks partial
content and supports explicit complete loading and cancellation.

The archive directory must match request-archive. The Web profile explicitly
mounts this plugin; other surfaces remain independent. Archive JSON is never
changed by inspection. The per-session index is derived data. Missing/corrupt
index state is reported separately from an empty session.

From the harness dsh directory, use the existing Node 22 runtime and pnpm
workspace installation, then run the plugin's isolated tests and build only its
client artifact. Production installs need lib/client.js as well as the source
Host entry; dsh source modifications are not required.

This captures the framework input before provider conversion and attachment
resolution. It is neither the provider's final HTTP body nor an unsent next-turn
preview, and an archive does not prove remote delivery or completion.

The composer also exposes additive current-context estimates and a separate
latest positive API usage report. Matching configured DeepSeek V4.1 routes use
the pinned offline reference tokenizer; unknown routes and oversized text use
explicit weighted estimates. Attachments or extension blocks are marked
incomplete rather than claiming exact occupancy. Cached input is included in
the API input total; output is excluded, and compaction usage is labelled.
No counting request or private context is sent to another provider.

Metrics use a removable native projection, numeric/hash-only checkpoints and
a scope-owned bounded tokenizer cache. Configure metrics.enabled to disable
the meter, metrics.tokenizerEnabled to use weighted estimates, and modelIds /
providerIds to control reference-tokenizer matching. The narrowly scoped CSS
adapter hides the native composer meter only while this slot is available;
it does not replace InputBar or modify native DSH. Refresh the browser after
deployment to clear a previously open native portal.

See [operations](../../docs/operations/context-inspection.md) and
[tokenizer provenance](tokenizers/PROVENANCE.md) for configuration, API semantics,
pinned assets, licenses and reference validation.

## Reproducing the focused checks

From the plugin directory on Spark, using the existing workspace installation:

```sh
cd /home/ayerelysia/Elysia/Elysium/Elysia-Harness/plugins/context-inspector
export PATH="/home/ayerelysia/.local/share/node-v22/bin:$PATH"
node ../../dsh/node_modules/vitest/vitest.mjs run --config vitest.config.ts
node ../../dsh/node_modules/tsdown/dist/run.mjs --config tsdown.config.ts
```

The test config uses exact source aliases from the vendored DSH config and one
worker. Fixtures use temporary or in-memory data. The bundle config selects
only this plugin's browser factory from the official preset, so `pnpm run
bundle` also builds only `lib/client.js` and its map. It does not build DSH or
emit Host declarations.

For the independently checked browser source plus shared wire types, this
no-output TypeScript check resolves installed dependency declarations instead
of compiling the entire DSH source graph:

```sh
node <<'JS'
const ts = require('../../dsh/node_modules/typescript')
const root = process.cwd()
const filename = root + '/tsconfig.json'
const loaded = ts.readConfigFile(filename, ts.sys.readFile)
const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root, undefined, filename)
const rootNames = parsed.fileNames.filter(file =>
  file.includes('/src/client/') || file.endsWith('/src/types.ts') || file.endsWith('/src/metrics-types.ts'))
const options = {
  ...parsed.options, paths: {}, noEmit: true, incremental: false, composite: false,
}
const program = ts.createProgram({ rootNames, options })
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
for (const item of diagnostics) {
  const pos = item.file?.getLineAndCharacterOfPosition(item.start ?? 0)
  const location = item.file ? item.file.fileName + ':' + (pos.line + 1) : ''
  console.error(item.code, location, ts.flattenDiagnosticMessageText(item.messageText, ' '))
}
console.log('Frontend noEmit:', rootNames.length, 'root files;', diagnostics.length, 'diagnostics')
process.exitCode = diagnostics.length === 0 ? 0 : 1
JS
```

These checks do not start a Web service, call a model, read real archive bodies,
or mutate a session. Deployment and authenticated browser verification are
separate steps owned by the operator.
