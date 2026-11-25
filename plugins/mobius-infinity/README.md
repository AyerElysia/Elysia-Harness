# @elysia/mobius-infinity

**Display identity:** Elysia/Mobius-Infinity · 梅比乌斯 · 无限

Create, list, and delete Agent presets that reference prompt files on disk, and
choose the tools each preset composes. A managed preset is the prompt files it
names, the normal time context, the tool group the operator configured, and the
fixed compaction group. The manager never creates or switches a session.

## What it owns

| Surface | Responsibility |
|---|---|
| Host service `presetManager` | Merges the preset roster with its own document, registers definitions, persists, deletes, probes tool availability, owns custom tool faces |
| Model tools `preset_list` / `preset_create` | Ordinary global tools registered at mount and disposed at unmount. No catalog, no enable flag, no private state, and no capability core. Both delegate validation and writes to the Host service; Chinese display names are optional orchestrator metadata and their absence changes nothing |
| Child `@elysia/mobius-infinity/prompt-files` | Renders the configured files as the complete system prompt; reports file changes |
| Web sidebar entry + `presets` main panel | Lists presets; deletes the manager-owned ones; navigates to the create page |
| Create page | Metadata, prompt files, and the tool-face configuration |

Out of scope, deliberately: prompt content editing, model and cwd selection,
session creation or switching, memory retrieval, and channel bridges.

## Composition

A managed preset contains four fixed rows, plus optional `agent-instructions`:

```yaml
plugins:
  # Optional: only when the create page enables AGENTS.md injection.
  - id: agent-instructions
    name: '@deepseek-ai/dsh-agent-instructions'
  - id: prompt-files
    name: '@elysia/mobius-infinity/prompt-files'
    config:
      identity: <required preset identity>
      root: <absolute prompt root>
      files: [SOUL.md, USER.md, MEMORY.md]
  - id: time-context
    name: '@deepseek-ai/dsh-time-context'
  # Omitted entirely for the chat-only face.
  - id: tools
    name: cordis:group
    group: true
    config:
      - id: tool-web
        name: '@deepseek-ai/dsh-tool-web'
        config: { fetch: true, searchTimeoutMs: 60000 }
  - id: compaction
    name: cordis:group
    group: true
    isolate: { compaction: true, toolResultPruner: true }
    config:
      - id: compaction-basic
        name: '@deepseek-ai/dsh-compaction-basic'
        config: { auto: true }
      - id: command-compact
        name: '@deepseek-ai/dsh-command-compact'
      - id: tool-result-pruner
        name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
```

`identity` is required and rendered before the file bodies, so a preset never
also mounts `@deepseek-ai/dsh-persona`: two identity sources would both reach
the model. The `tools` group holds exactly the tool ids the record saved; an
empty tool set omits the group rather than mounting an empty one.

## Tool catalog and coverage

`src/tool-catalog.ts` is the closed list of tools a preset can compose here:

| Tool | Module | Notes |
|---|---|---|
| `tool-web` | `dsh-tool-web` | search + fetch; the default face |
| `tool-fs` | `dsh-tool-fs` | read/write/edit |
| `tool-fs-search` | `dsh-tool-fs-search` | grep/glob |
| `tool-bash` | `dsh-tool-bash` | disabled on Windows by a Loader `!!js` expression |
| `tool-pwsh` | `dsh-tool-pwsh` | disabled outside Windows by a Loader `!!js` expression |
| `tool-todo` | `dsh-tool-todo` | |
| `tool-ask-user` | `dsh-tool-ask-user` | |
| `tool-skill` | `dsh-tool-skill` | |
| `tool-jobs` | `dsh-tool-jobs` | |
| `tool-goal` | `dsh-tool-goal` | |
| `tool-subagent` | `dsh-tool-subagent` | one `spawn` provider row |
| `tool-agent-team` | `dsh-tool-agent-team` | |
| `tool-present` | `dsh-tool-present` | |
| `tool-office` | `dsh-tool-office` | |

A catalog entry carries the configuration the row always receives, so a stored
tool id means the same module and config the page showed. Two rows are
platform-gated instead of removed, matching the shipped presets: the Loader
evaluates the expression at mount, so the row that cannot run simply never
starts and the preset still composes.

### Exclusions

"Every tool" means every tool this deployment can compose **inside a preset
realm**. These model-facing tools stay out, with the reason:

| Module | Why it is not a preset toggle |
|---|---|
| `dsh-tool-working-directory` | Mounted on the Host plane in `dsh-base`, so every Agent already has `working_directory`. A preset row would duplicate a tool that is always present; the preset cannot switch it off. |
| `dsh-tool-workflow` | Injects `workflowEngine`, which the shipped `standard` preset supplies through a preset-local `workflow-ptc` row inside an isolate group. A bare row would wait on a service the preset does not mount. |
| `dsh-tool-schedule` | Its Host provider is profile-dependent (this Web profile disables the `schedule` row in its own patch); a preset row could stay pending or call a missing service. |
| `dsh-tool-lsp` | No `lsp` Host provider row is part of the shipped bundles. |
| `dsh-plugin-manager/tools` | Profile-gated tool surface for installing plugins; not a capability a preset chooses. |
| `dsh-tool-terminal`, `dsh-tool-bash-persistent`, `dsh-tool-pwsh-persistent` | Belong to the `minimal` preset's isolated terminal group; they need the `terminal` and `terminals` rows that group mounts. |
| Experimental tools (`tool-worktree`, `tool-session-query`, `tool-ralph`, …) | Their packages are not mounted by the shipped bundles. |

The list is code, not configuration: it changes with a code change and a test,
never with a runtime probe that could silently drop a row.

### Availability probe

`listToolFaces()` registers a one-row preset for every catalog entry, asks the
registry for that preset's diagnostic, and disposes it. The diagnostic is empty
exactly when the registry mounted the row and audited every service it waits on,
so a tool that cannot activate is reported `available: false` with the registry's
reason instead of being offered as a switch that would break the preset. Results
are cached for the Host process: the set of Host services that can satisfy a
preset row is fixed until restart. If the registry refuses every probe before a
scope exists, the manager falls back to the static catalog and logs a warning.

## Tool faces

| Family | Ids | Editable |
|---|---|---|
| default | `default` — network search only (`tool-web`) | no |
| common | `none` (no tools), `search`, `search-files`, `full` | no |
| existing | one per registered preset, read from `ctx.agentPresets.compositionInventory()` | no |
| custom | operator-created, stored in the manager document | delete only |

Selecting a face rebuilds **every** switch from that face, so `none` turns all
of them off. Adjusting a single switch afterwards clears the face reference: the
saved tool ids are then the operator's own set. An existing preset's face keeps
only the tool ids this catalog offers; rows it cannot offer are listed in
`missing` and the face is marked `partial`.

## Model tools

`preset_list` and `preset_create` are ordinary global tools. Mounting the bundle
row registers both with `ctx.tools.register()`, and disposing the row removes
them. There is no catalog, no enable flag, no private enabled state, and no
capability core. A deployment without the `tools` service has no model tools,
while the panel and the Host service keep working.

Chinese display names (`preset_create` → 创建预设, `preset_list` → 列出预设) are
optional display metadata. When the orchestrator service `villvHelix` is present,
the Host registers them through `registerToolName()` inside an effect, and their
disposers remove them on unmount. Without the orchestrator the tools run normally
under their ids; the model schema never receives the Chinese names.

| Tool | Behavior |
|---|---|
| `preset_list` | Does not write the manager document. Returns the merged roster, every catalog tool with its availability, and every tool face. When `promptRoot` is supplied, it also lists the non-blank `*.md` files directly inside that directory with their sizes. |
| `preset_create` | Validates the draft, resolves the prompt root and files, obtains the call's permission, then delegates to `ctx.presetManager.create()`. Returns the created preset's id, name, prompt files, tools, order, and face provenance. |

`preset_create` parameters:

- `id`, `name`, `identity`, and `promptRoot` are required.
- `promptFiles` is optional. When omitted, every non-blank `.md` file directly
  inside the root is used, sorted by name. Explicit paths are normalized and
  checked before the permission question, so a typo fails without a prompt.
- `tools` is optional. Omission means the default face (`tool-web`), or the
  tools of `toolFace` when one is supplied; an empty array means a preset with
  no tools. The parameter enum is the code-owned catalog, and a requested id
  whose probe reports `available: false` is refused with `TOOL_UNAVAILABLE`
  before the permission question.
- `description`, `toolFace`, `agentInstructions`, and `order` are optional and
  match the create page. A `toolFace` must name a face from the current
  catalog, so stale provenance fails before the prompt. Supplying both
  `toolFace` and `tools` requires them to describe the same tool set; the face
  order wins.

Refusals reuse the Host service's stable codes (`PRESET_ID_INVALID`,
`PRESET_ID_EXISTS`, `PROMPT_ROOT_MISSING`, `PROMPT_FILE_INVALID`,
`PROMPT_FILES_EMPTY`, `PRESET_REGISTER_FAILED`, ...) and cross the tool
boundary as structured `HarnessError` codes. A refusal happens before
registration and before the document write. `TOOL_UNAVAILABLE` and
`TOOL_FACE_NOT_FOUND` are tool-level refusals with the same timing.

Permission: the create path requires `danger-full-access`. A session already in
that mode runs the call without a prompt; a narrower session asks through the
approval seam to widen for this one call. The approval authorizes a direct
write by the Host service; the tool does not run a sandboxed command, so the
grant is a permission decision, not a mode applied to a child process. The tool
has no confirmation dialog of its own. A missing `sandboxPolicy` service fails
closed with `SANDBOX_POLICY_UNAVAILABLE`; a narrower session with no approval
channel fails with `SANDBOX_ESCALATION_UNAVAILABLE`.

Creating a preset never creates or switches a session. Existing sessions keep
the preset they recorded; the new preset is available to sessions started
afterward.

## Host service

`PresetManager` (`ctx.presetManager`) is a `TypertRemoteService` on the
`presetManager` namespace.

| Method | Behavior |
|---|---|
| `list()` | Every registered preset plus every owned record, with `managed`, `inUse`, `diagnostic`, `promptRoot`, `promptFileCount`, `tools`, `unknownTools`, `createdAt` |
| `listToolFaces()` | The probed tool options and the default, common, existing-preset, and custom faces |
| `createToolFace(input)` | Validates the name and ids, requires at least one tool, refuses a duplicate name, stores a `custom-<hex>` face |
| `deleteToolFace(id)` | Deletes a custom face; built-in, common, and existing-preset ids are refused as read-only |
| `create(draft)` | Validates, registers, then persists; a refused definition rolls back |
| `delete(id, options?)` | Disposes one owned registration and drops the record; custom faces survive |
| `listPromptCandidates(root)` | The `*.md` files directly inside a prompt root, sorted by name, with sizes |

Refusals cross the wire as `presetManager/<CODE>`:

`PRESET_ID_INVALID`, `PRESET_ID_EXISTS`, `PRESET_NAME_INVALID`,
`PRESET_IDENTITY_INVALID`, `PRESET_NOT_FOUND`, `PRESET_NOT_MANAGED`, `PRESET_IN_USE`,
`PRESET_UNREGISTERED`, `PRESET_REGISTER_FAILED`, `PRESET_DISPOSE_FAILED`,
`PROMPT_ROOT_MISSING`, `PROMPT_ROOT_INVALID`, `PROMPT_FILE_INVALID`,
`PROMPT_FILE_OUTSIDE_ROOT`, `PROMPT_FILE_EMPTY`, `PROMPT_FILES_EMPTY`,
`TOOL_UNKNOWN`, `TOOL_FACE_INVALID`, `TOOL_FACE_NOT_FOUND`, `TOOL_FACE_EXISTS`,
`TOOL_FACE_READONLY`, `STATE_INVALID`, `STATE_WRITE_FAILED`.

`preset_create` maps the same refusals onto `HarnessError` codes (`PRESET_ID_EXISTS`,
`PROMPT_FILE_INVALID`, ...), so the model sees a structured failure and the
session log records the same discriminator.

### Validation

An id is `[a-z0-9-]+`, and the injected identity must be non-blank. The prompt root must be an absolute, existing directory;
it is stored as its real path. Every file must be a relative path that stays
inside that root after symlink resolution, must be a regular file, and at least
one file must be non-blank. Ids are unique across the whole roster, so a
managed preset can never shadow a bundle or profile declaration. Tool ids must
resolve through the catalog, duplicates collapse, and a `custom` face reference
must name a stored face.

### Persistence and startup

The document is `presets.json` under `stateDir`, versioned, written through a
temporary file and one rename:

```json
{
  "version": 2,
  "presets": [
    {
      "id": "elysia-conscious",
      "name": "Elysia conscious",
      "description": "...",
      "identity": "...",
      "promptRoot": "E:/.../prompts",
      "promptFiles": ["SOUL.md", "USER.md"],
      "tools": ["tool-web"],
      "toolFace": { "kind": "default", "id": "default" },
      "order": 10,
      "createdAt": "2026-11-22T00:00:00.000Z"
    }
  ],
  "toolFaces": [
    { "id": "custom-1a2b3c4d", "name": "Writing", "tools": ["tool-web", "tool-fs"] }
  ]
}
```

A version 1 document is read without rewriting it: a record with no `tools`
composes `["tool-web"]`, the face it was created with, and the document keeps
its old generation until the next mutation writes version 2. An explicit empty
`tools` list is the chat-only face and stays empty.

On activation the manager re-registers every record and keeps one disposer per
preset. A definition that fails to register stays listed with its diagnostic and
does not block the others. Disposing the plugin disposes every registration it
made.

The document is the manager's source of truth, not a preset declaration:
`agentPresets.register()` is runtime state and is never written to a bundle or a
profile patch. Turning a managed preset into a shipped preset needs a generated
bundle, which v1 does not do.

### Delete policy

A preset a live session runs is always refused with `PRESET_IN_USE` and the
session ids: the roster entry is what that session resumes on, and disposing it
would leave the session unrestorable. `force` never overrides that.

`force` has one meaning, and only one: it drops an owned document entry whose
registration is gone (a definition that failed at startup, or one whose
registration was disposed outside the manager). Without `force` that entry is
refused with `PRESET_UNREGISTERED`, so a broken preset stays visible until the
operator says what to do with it.

Deleting a preset never deletes prompt files and never deletes custom tool
faces: the face library belongs to the operator, not to one preset.

`inUse` covers live Agents in the running Host process. Sessions persisted but
not resumed are not referenced, because the projection that records a preset
belongs to a live Session.

## The `prompt-files` child

Mounted in a preset's scope, so one row serves every Agent composed under that
preset. It mirrors `@deepseek-ai/dsh-time-context`'s preset-scope handling: an
Agent-scoped mount reports only its own Agent, a preset row reports each Agent
routed to it.

- Every assembly re-reads `root/files` and registers one `systemPrompt.section`
  with `complete: true` and `interpolate: false`. File order is render order.
- A configured file that becomes unreadable is named in the prompt instead of
  being dropped silently.
- On `agent/pre-step` the child compares per-file SHA-256 hashes against what it
  last told that session and injects one notice:
  `source.kind = 'elysia-prompt-change'`, `form: 'snapshot'`, a `changes` array
  of `{ action: 'add' | 'modify' | 'remove', path }`. The notice names paths and
  actions only; the bodies are already in the system prompt.
- The previous notice is replaced in place (`surfaceOp: 'replace'`), so notices
  never accumulate.
- A session's first observation is its baseline, so a new session is not told
  about edits made before it started.

All configured files are mutable input. The child assumes nothing about which
file is stable, and it never writes to any of them.

## Web panel

One left-sidebar entry (`sidebar.panellist`, id `presets`, order 30) opens the
keyed `main` panel `presets`. The list shows the merged roster with `managed` /
`in use` / diagnostic badges, the tool count, and disables delete for built-in
and in-use presets.

"New preset" switches the panel to a dedicated create view with a visible Back
action; the list is re-read when it is shown again. The create view holds the
metadata, the prompt-root pick, the ordered file selection, and the tool
configuration:

- one checkbox per catalog tool, disabled with its diagnostic when the probe
  could not activate it, and marked for the platform a shell row targets;
- a face selector listing the default, common, existing-preset, and custom
  faces, which rewrites every checkbox as soon as it changes;
- a name field plus "save switches as a face" for the custom family, and a
  delete action that appears only for a selected custom face.

The panel edits no content and creates no session. The Host directory picker
supplies the prompt root; `listPromptCandidates` fills the file list, and
selection order is render order.

## Develop

```sh
cd plugins/mobius-infinity
pnpm install          # one project-local workspace; `link:` deps reach ../../dsh
pnpm test             # vitest, 77 specs
pnpm run typecheck    # tsc --noEmit
pnpm run build        # emits lib/host/
pnpm run bundle       # emits lib/client.js for the Web shell
```

The package is outside the vendored `dsh/` workspace, so it resolves workspace
packages through `node_modules` links to the vendored build (`lib/`), which is
the artifact plane the shipped profiles load. `tsconfig.json` therefore clears
the base config's source `paths`; compiling dsh's sources from outside its own
project references fails, and `const enum FiberState` arrives as `undefined`
under esbuild's per-file transform.

Tests use the real registrar for structure checks (`entryListProblem`) and
in-memory substitutes for the preset and Agent registries, which are the seams
this plugin adapts to.

## Mount

The profile owns the dependency edge and the bundle row:

```json
{
  "dependencies": {
    "@elysia/mobius-infinity": "link:../../../../plugins/mobius-infinity"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@elysia/mobius-infinity"]
    }
  }
}
```

Then run `pnpm install` in the profile directory, and build the browser half once
inside the package (`cd plugins/mobius-infinity && pnpm run bundle`) so
`lib/client.js` exists — the package is its own workspace root, so the profile
cannot filter it. The Host row comes from this package's `cordis.patch.yml`,
which uses the `mobius-infinity` state directory; the old `preset-manager`
directory was moved with the roster intact. Mounting the row registers
`preset_list` and `preset_create` as ordinary global tools; removing the row
disposes both.

No capability core or capability panel package is required. The optional
orchestrator (`villvHelix`) receives the Chinese display names; without it the
tools keep their ids and work the same.

## Known gaps

- **Catalog coverage is closed by code.** A tool package the catalog does not
  name cannot be toggled, even if the deployment could compose it; adding one is
  a code change plus a test. The exclusions table above is the current boundary.
- **The availability probe runs once per Host process.** Installing a plugin that
  provides a previously missing service needs a Host restart before its tool
  appears as available.
- **The model surface is create/list only.** Deleting a preset remains a panel
  action, because a live session's recorded preset is what that session resumes
  on and the refusal needs an operator decision.
- **An existing preset's face collapses duplicate modules.** `standard` mounts
  `dsh-tool-subagent` twice (`subagent` and `subagent_fork`); the face carries the
  single catalog row, so applying it yields `subagent` only.
- No content editor by design; a changed prompt body is picked up by the next
  assembly and announced by the child.
- `inUse` cannot see archived or unevaluated sessions; only live Agents report.
- A managed preset cannot be exported to a bundle, so it exists only in one home.
- The page is covered by typecheck, a built bundle, service-level adapter specs,
  and a pure create-page state spec; there is no jsdom component test (no
  `@testing-library/react` install for this package).
- Creating a preset whose files are later deleted leaves the definition intact;
  the child reports the missing files in the prompt, and the operator deletes and
  recreates the preset.
