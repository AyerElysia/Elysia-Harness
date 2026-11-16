# 2026-11-13 仓库卫生：Breeze 子模块失效与 .gitignore

本次改的是两条一直让 `git status` 说不了话的东西：`breeze-realtime-review/Breeze-TTS-2.cpp/`
的“子模块失效”，和 `.gitignore` 里没覆盖到的构建产物 / 一次性产物。改动只涉及仓库管理，
不碰任何运行时代码。

## 1. 子模块失效：tarball 里带进来的悬空 gitlink

`Breeze-TTS-2.cpp` 把 ggml 与 shine 声明成 submodule（`third_party/ggml`、`third_party/shine`），
它们的 `.git` 是两行文本：

```text
gitdir: ../../.git/modules/third_party/ggml
gitdir: ../../.git/modules/third_party/shine
```

这两条路径相对的是**独立 clone 的根**。整棵树被 `breeze-tts-2-cpp-source.tar.gz` 打包、再解到
本仓库里之后，那个 `.git/modules` 并不存在，指针悬空；本仓库顶层也没有 `.gitmodules`、没有
`160000` 条目，于是 Git 既不把它当 submodule，也不把它当普通目录，而是把 2 204 个 ggml 文件
和 77 个 shine 文件全部报成未跟踪文件。

处理：删掉那两个 `.git` 指针文件（只影响 Git，不影响 CMake 构建），并在 `.gitignore` 里忽略
整个 `Breeze-TTS-2.cpp/`。删掉指针后，其子目录里的 Git 命令会正常向上找到本仓库根：

```text
$ git -C breeze-realtime-review/Breeze-TTS-2.cpp/third_party/ggml rev-parse --show-toplevel
/home/ayerelysia/Elysia/Elysium/Elysia-Harness
```

为什么忽略而不是重新登记成套娃子模块：这棵树的身份由 tarball 固定（`sha256:3374d57f…8ed9`，
记录在 `breeze-realtime-review/README.zh.md` §3），重新登记只会再引入两个上游 URL 和一次网络
依赖，换不到更多可复现性。

tarball 本身**不忽略**——它没有 git 元数据，是唯一能精确还原那次基准测试所用源码的东西，
5.9 MB 一次性成本可以接受。但要注意它到 2026-11-16 为止仍**没有**进仓库（见 §3 末段）。

重建方式（`.gitignore` 里同样写着）：

```sh
tar xzf breeze-realtime-review/breeze-tts-2-cpp-source.tar.gz -C breeze-realtime-review/
rm -f breeze-realtime-review/Breeze-TTS-2.cpp/third_party/{ggml,shine}/.git
```

核对这次 checkout 是否仍是 tarball 里那一个：`diff -r` 除 `build-cuda*` 外应只有这两行指针差异。

## 2. .gitignore：三类漏网内容

改前 `git status --porcelain -uall` 是 **2802** 行，改后 **16** 行（含远端当时未提交的 3 个功能改动）。

| 漏网内容 | 数量 | 处置 |
|---|---|---|
| 原地编译产物（`dsh/**/src` 下的 `.js`/`.js.map`/`.d.ts`/`.d.ts.map`） | 300 | 按四种形态忽略；手写的环境声明逐名重新纳入（8 个文件名），见下 |
| `Breeze-TTS-2.cpp/` 整棵树（含 `build-cuda*`） | 2 702 | 忽略，理由见上 |
| `breeze-realtime-benchmark/`（原始逐块结果 + 试听 wav + server log） | 68 | 忽略；结论在 `docs/` 与 `breeze-realtime-review/` |
| `modsearch-review/`（解开的 npm 包 + 配置 dump + log 尾） | 43 | 忽略 |
| `homes/web/*.mjs`（写死本机绝对路径的临时脚本） | 2 | 忽略 |
| `plugins/*/pnpm-lock.yaml`（在插件目录误跑 `pnpm install` 的残留） | 1 | 忽略；插件是 `dsh/pnpm-lock.yaml` 的 importer，作者性唯一 |

### 环境声明不能一起忽略

`dsh/**/src` 里有 69 个**被跟踪**的 `.d.ts`（`css-modules.d.ts`、`assets.d.ts`、`vite-env.d.ts` 等），
它们是手写源码而不是 emit。因此规则写成“先按形态忽略、再逐名 `!` 纳入”，目前纳入 8 个文件名：

```text
asset-imports.d.ts  assets.d.ts  css-modules.d.ts  ripgrep.d.ts
styles.d.ts  turndown-plugin-gfm.d.ts  use-sync-external-store.d.ts  vite-env.d.ts
```

新增一个同名环境声明时，要在同一处补一行，否则它会静默变成未跟踪。

### 验证手段

- 被跟踪文件误伤检查：`git ls-files | git check-ignore --stdin` 输出为空。
- tracked-but-ignored 保持在改动前的 2 个（`homes/*/profiles/*/pnpm-lock.yaml`），没有新增。
- 抽查 emit 文件 `dsh/packages/core/agent/src/index.d.ts` 被忽略、手写 `styles.d.ts` 不被忽略，
  `git check-ignore -q` 退出码分别为 0 和 1。
- `git add -A` 干跑在 `Breeze-TTS-2.cpp/` 上直接报“被 .gitignore 忽略”，不会误吞 2 400 个文件。

## 3. 这些规则最后是怎么进仓库的

本机改完后，Spark 侧在 `af3b94ca5e` 里把同一份规则提交了（内容是本机版本再加一段
“Build scratch and one-off backups”：`FindCUDAToolkit.cmake`、`results/`、`*.bak`、
`.backup-*/`）。逐行核对过：本机版本 173 行、远端 183 行，本机的每一行都在远端版本里，
没有一条被改写或丢失。所以 `.gitignore` 本身已无需再提交，本机快进到 `af3b94ca5e` 后即与
`origin/master` 完全一致。

顺带发现一处不一致：提交信息里写着 tarball 是“唯一精确 pin、故意不忽略”，但 `Breeze-TTS-2.cpp/`
清理时把它当成 worktree junk 挪到了 `/tmp/elyh-worktree-junk-20261116-091353/breeze/`，
仓库里其实**没有**这个文件，也从未提交过。sha256 校验仍是 `3374d57f…8ed9`，已取回。

## 4. 未处理的两处重复

- `breeze-realtime-review/results-plugin-q8-interruption.json` 与 `results/plugin-q8-interruption.json`
  同名不同内容（前者是早期版本），wav 则完全一致。保留 `results/` 一份，另一份待确认后删除。
- 仓库根的 `breeze-realtime-review-benchmark.py` 与 `breeze-realtime-review/benchmark_realtime.py`
  `sha256` 完全相同（`de325379…`），是复制遗留。`af3b94ca5e` 已把根上那份提交进仓库，
  `breeze-realtime-review/` 里那份反而没进；删任何一份都需要确认。

## 5. 没做的事

- 没动父仓库 `Elysium` 的子模块指针：父仓库仍记着 `Elysia-Harness @ 03f13b906`，而子模块已在
  `af3b94ca5e`。这是父仓库的提交，另议。
