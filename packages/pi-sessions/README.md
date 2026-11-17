# @sion10032/pi-sessions

用 `/sessions` 浏览、搜索、恢复、归档与取消归档 pi 会话；归档父会话时，它的子代理会话与 fork 会一起移动。

## 功能概览

- **统一浏览**：一个 `/sessions` 界面里同时看活跃会话与归档会话，支持模糊搜索、`"整段短语"`、`re:<pattern>` 正则、树形折叠、`current`/`all` 作用域、命名过滤、路径显示与三种排序。
- **picker 内归档**：`ctrl+a` 归档/取消归档选中会话，所有动作都先显示确认行。归档父会话时，整棵 `parentSession` 子树（子代理会话、fork 及其后代）一起移动。
- **整棵子树恢复**：`enter` 恢复归档会话；归档文件先移回活跃目录，再切换过去。根会话与全部派生会话一起回来。
- **当前会话延迟归档**：pi 正在写入的文件不能移动，所以 `/archive`、`archive_session` 工具和 picker 对当前会话的 `ctrl+a` 只记录“关闭后归档”，等会话关闭时才移动；`/reload` 不移动。
- **物理移动，不靠索引**：归档状态由“文件在 `sessions/` 还是 `sessions-archive/`”决定，因此原生 `/resume` 始终干净，索引丢失也不会丢归档。
- **不改写会话**：归档不改 header、不调用 `setSessionName`，未命名会话继续显示首条消息；只会在恢复时剥除旧插件留下的 `[ARCHIVE] ` 名称标签。
- **无网络**：所有操作都是本地文件移动与本地搜索。

## 安装

发布后从 npm 安装：

```bash
pi install npm:@sion10032/pi-sessions
```

从本仓库的本地路径安装（写入 `~/.pi/agent/settings.json`）：

```bash
pi install ./packages/pi-sessions
```

只想试一次、不写入设置：

```bash
pi -e ./packages/pi-sessions
```

包在 `package.json` 的 `pi.extensions` 里声明入口 `./src/index.ts`，pi 直接加载 TypeScript 源码。依赖 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox` 由 pi 自身提供（peer dependency），不需要单独安装。

## 命令与工具

| 名称 | 用法 | 说明 |
| --- | --- | --- |
| `/sessions` | `/sessions [active\|archived\|all]` | 打开会话列表；可选参数只决定初始的归档筛选，打开后仍可切换 |
| `/archive` | `/archive` | 把当前会话标记为“关闭后归档” |
| `archive_session` | 工具调用，无参数 | 同上，供 agent 在用户说“工作完成了”时调用 |
| `/resume` | 原生命令 | 仍可正常使用，只看活跃会话（归档会话不在其中） |

`/archives` 已移除。旧操作在新界面里的对应关系：

| 旧插件 | 现在 |
| --- | --- |
| `/archives` 浏览归档 | `/sessions` 后按 `ctrl+t` 切到 `archived` |
| `Restore and resume` | 在归档行上按 `enter` |
| `Restore only` | 在归档行上按 `ctrl+a` |
| `Resume, keep archived` | 不再提供：恢复后再归档即可 |

在非 TUI 模式（例如没有自定义组件的界面）下，`/sessions` 退化为 `ctx.ui.select` 的扁平编号列表，只支持恢复；归档请用 `/archive` 或 `archive_session` 工具。那里没有 `ctrl+t`，所以列表默认同时显示活跃与归档会话（归档行带 `[archived]` 标记）；用 `/sessions active` 或 `/sessions archived` 可以只看其中一种。

## `/sessions` 键位

| 键 | 行为 |
| --- | --- |
| `tab` | 切换作用域：`current`（当前目录）↔ `all`（所有目录） |
| `ctrl+s` | 切换排序：`threaded` → `recent` → `relevance`；只在树内重排，子会话仍默认折叠 |
| `ctrl+n` | 只看命名会话，再按一次显示全部 |
| `ctrl+p` | 显示/隐藏会话文件路径 |
| `ctrl+t` | 切换归档筛选：`active` → `archived` → `all` |
| `ctrl+e` | 展开/折叠选中行的子树（折叠时父行右侧显示 `↳N`） |
| `ctrl+a` | 归档/取消归档选中会话（先确认）；当前会话为延迟归档，已归档的当前会话不做任何操作 |
| `enter` | 恢复选中会话（归档会话会先移回活跃目录） |
| `esc` | 取消 |
| `↑` / `↓`、`pgup` / `pgdn` | 上下移动、翻页 |
| 鼠标滚轮 / 左键单击 | 滚动列表 / 选中行 |
| 其他输入 | 进入过滤框：空格分词（模糊匹配）、`"整段短语"`、`re:<pattern>` |

说明：

- 默认状态为 `scope: current`、`sort: threaded`、归档筛选 `active`、`named: All`、`path: off`；当前会话高亮，归档行带暗色 `[archived]`。
- 标题栏与原生会话选择器一致：`Sessions (Current Folder)` / `Sessions (All)`，`> ` 过滤框，选中行高亮，命名会话用 warning 色，当前会话用 accent 色。
- 有过滤词时，列表退化为扁平结果列表（与原生 picker 一致）；没有过滤词时，无论切换哪种排序，子会话都保持嵌套并默认折叠。
- 折叠时父行右侧显示 `↳N` 后代数（即使标题很长也不会被截掉）；展开后子行使用原生 `├─` / `└─` 树形前缀。
- `ctrl+a` 的所有动作都会先显示确认行，且不显示标题（长标题不会把动作文字挤掉）：`Archive this session?`、`Archive this session and N child sessions?`、`Unarchive this session?`、`Archive the current session when it closes?`；`enter` 确认，`esc` 取消。
- `tab`、`ctrl+s`、`ctrl+n`、`ctrl+p` 使用 pi 的键位名 `tui.input.tab`、`app.session.toggleSort`、`app.session.toggleNamedFilter`、`app.session.togglePath`，可在 `~/.pi/agent/keybindings.json` 里改；`ctrl+t`、`ctrl+e`、`ctrl+a` 是本插件直接读取的按键，不可改。

## 归档语义

**物理移动。** 归档把 `<agent>/sessions/<cwd-slug>/x.jsonl` 移到 `<agent>/sessions-archive/<cwd-slug>/x.jsonl`，取消归档做反向移动。归档状态只由目录位置推导，不写进会话文件，也不依赖索引。

**整棵子树。** 递归按会话 header 里的 `parentSession` 进行：父会话所在目录中，凡是 `parentSession` 指向该会话或其后代的 `.jsonl`，都属于这棵子树。pi 在文件格式上无法区分“子代理会话”和“`/fork` 派生的会话”，两者一律当作派生会话一起归档，这正是为了避免在原生 `/resume` 里留下孤儿根节点。恢复同样整棵移回；只恢复某个子会话时，父会话仍留在归档里，树形视图会按“孪生路径”继续把它挂在归档父节点下。**正在写入的会话除外**：当前会话的文件，以及它自己的派生会话，永远不随着祖先会话的归档而移动（连同伴生文件一起留在原地），否则 pi 会继续往旧路径写，会话就从 `/resume` 里消失了。

**当前会话延迟归档。** pi 还在写当前会话的文件，移动它会丢内容，因此：

- `/archive`、`archive_session` 工具、picker 里对当前会话按 `ctrl+a`，都只往 `<agent>/pi-sessions-state.json` 的 `pendingArchive[<sessionId>]` 写一条请求，并提示 `Session will be archived when it closes`。
- 真正移动发生在 `session_shutdown`：退出 pi、`/new`、切换到别的会话、`/fork` 都会触发；`/reload` 不移动（会话马上回来），切换目标恰好是同一个会话文件也不移动。切换或 `/fork` 的目标是当前会话的派生会话时，那个目标文件同样不移动（pi 正要继续写它），只移动当前会话本身。文件已归档或已不存在时只清掉请求；移动失败会通知错误并保留请求，便于下次重试。
- 移动成功后清掉请求。下次启动时若请求还在、而文件仍在活跃树，会继续武装（崩溃自愈）；若文件已在归档树，则丢弃请求。

**目标文件已存在。** 归档时若归档位置已有同名文件，先判断它是否只是“尾巴”（没有 session header，且条目通过 `parentId` 接到归档副本上）：是则把尾巴追加到归档副本并删除；否则把旧文件改名成 `<file>.superseded-<timestamp>` 保留，绝不覆盖。

**伴生文件。** 会话除了 `.jsonl` 还带有：同名目录（子代理运行、fork 等）、`.pi-agent-browser-artifacts/<sessionId>/`、`subagent-artifacts/` 下 `_meta.json` 的 `parentSessionId` 指向该会话的运行产物。它们随会话一起移动；某个伴生文件移动失败只会被跳过，目标已存在时保留原处。

**活跃副本优先。** 取消归档时若活跃树里已经有同名文件（归档后 pi 又写了活跃副本），不会移动任何东西，只提示 `A live copy already exists`，归档副本原样保留；用 `enter` 恢复则直接切到活跃副本。

**不做的事。** 本插件不提供重命名与删除（原生 `/resume` 仍可做），也不改写 `parentSession` 路径：父子链接在读取时按“孪生路径”解析。

## 归档布局

`<agent>` 默认是 `~/.pi/agent`，可用 `PI_CODING_AGENT_DIR` 覆盖；归档根目录始终是 `<agent>/sessions-archive/`。

```text
~/.pi/agent/
├─ sessions/<cwd-slug>/                          # 活跃会话（pi 自己维护）
│  ├─ <timestamp>_<id>.jsonl
│  ├─ <timestamp>_<id>/                          # 伴生目录（子代理运行、fork 等）
│  ├─ .pi-agent-browser-artifacts/<id>/          # agent-browser 截图，按会话 id
│  └─ subagent-artifacts/<run>_*                 # pi-subagents 运行产物
├─ sessions-archive/
│  ├─ <cwd-slug>/                                # 与活跃目录一一对应
│  │  ├─ <timestamp>_<id>.jsonl
│  │  ├─ <timestamp>_<id>/
│  │  ├─ .pi-agent-browser-artifacts/<id>/
│  │  └─ subagent-artifacts/<run>_*
│  └─ index.json                                 # 归档元数据（不是归档状态的依据）
└─ pi-sessions-state.json                        # 延迟归档队列
```

`<cwd-slug>` 与 pi 的会话目录命名一致：`--` + 工作目录去掉开头的 `/`、把 `/` 和 `:` 换成 `-` + `--`。例如 `/home/sion/dev/pi-extensions` → `--home-sion-dev-pi-extensions--`。

`index.json` 以会话文件相对 `sessions-archive/` 的路径为键：

```json
{
  "--home-sion-dev-pi-extensions--/2026-11-16T15-43-01-628Z_<id>.jsonl": {
    "name": "会话名",
    "cwd": "/home/sion/dev/pi-extensions",
    "archivedAt": "2026-11-16T15:50:00.000Z",
    "id": "<id>"
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| 键 | string | `<cwd-slug>/<file>.jsonl`，相对归档根目录 |
| `name` | string | 归档时的会话名；未命名为 `""`；派生会话条目固定为 `""` |
| `cwd` | string | header 里的 `cwd`，缺失为 `""` |
| `archivedAt` | string | ISO 时间戳，`/sessions` 用它显示归档时间 |
| `id` | string? | header 里的会话 id，可选（旧数据可能没有） |

`/sessions` 只用到 `archivedAt`，缺失或索引损坏时回退到 `SessionInfo.modified`（最后消息时间）；`name`、`cwd`、`id` 仅作记录（标题始终取自会话文件本身）。

`pi-sessions-state.json` 只保存延迟归档请求：

```json
{
  "pendingArchive": {
    "<session-id>": {
      "path": "/home/sion/.pi/agent/sessions/--x--/<file>.jsonl",
      "cwd": "/x",
      "requestedAt": "2026-11-16T15:50:00.000Z"
    }
  }
}
```

## 限制

- **自定义会话目录不参与**：用 `--session-dir`、`PI_CODING_AGENT_SESSION_DIR` 或 `sessionDir` 设置把会话放到 `<agent>/sessions/` 之外的，不会出现在 `/sessions`，也不能被归档或恢复（原生 `/resume` 仍可见）；`/archive` 与 `archive_session` 工具会提示该会话无法归档，不会留下永远执行不了的延迟请求。归档根目录始终是 `<agent>/sessions-archive/`。
- **跨目录派生会话不会递归带走**：递归只扫描父会话所在目录的 `*.jsonl`。若子代理会话写到了别的工作目录，它不会被一起归档，会继续以孤儿根节点出现在原生 `/resume` 里。
- **另一个 pi 实例正在使用的会话不要归档**：插件不检测会话是否被其他实例占用。归档一个正在被写入的会话可能丢掉尚未落盘的内容。
- **多实例并发写**：`index.json` 与 `pi-sessions-state.json` 都是读-改-写加原子替换，并发时是 last-write-wins，后写的一方会覆盖先写条目的修改。同一时段最好只用一实例执行归档。
- **同 id 的重复副本只显示一行**：会话既在活跃树又有归档副本时（归档后 pi 仍写了活跃文件），活跃副本优先，归档副本暂时隐藏，活跃副本消失后重新出现。
- **`.superseded-*` 不自动清理**：被替换下来的旧归档文件需要手动删除。

## 隐私

插件不发起任何网络请求，也没有遥测。它只读写本机 `<agent>` 下的会话文件、`sessions-archive/` 与 `pi-sessions-state.json`；搜索完全在本地进行。归档/恢复是本地文件移动，不会上传或复制会话内容到别处。

## 从 `pi-session-archive` 迁移

1. **先移除旧包**，避免两个插件同时移动同一批文件（双重归档）：

   ```bash
   pi remove npm:@clementprevot/pi-session-archive
   ```

   若当初是用本地路径或 git 来源安装的，把来源换成当初写入设置的那一个。

2. **旧归档无需转换**：目录布局相同（都是 `sessions-archive/<cwd-slug>/`），`index.json` 字段兼容；新插件只读取 `archivedAt`，缺字段或损坏时回退到 `SessionInfo.modified`（最后消息时间）。
3. **旧标签展示时清理**：旧插件给未命名会话写过 `[ARCHIVE] ` 前缀名称，甚至只写一个裸的 `[ARCHIVE]`。新插件展示时会去掉名称开头的一个或多个 `[ARCHIVE]` 标签，结果为空则显示首条消息（在“只看命名会话”过滤下，这类只剩标签的会话被视为未命名）。
4. **恢复时剥除标签**：恢复归档会话时，如果文件里最后一个 `session_info` 的名称以 `[ARCHIVE]` 开头（可带空白、可重复），会把开头这些标签去掉后再写回（临时文件 + rename），免得下次关闭又被当成旧归档重复处理；没有标签的名称保持原样。
5. **旧插件已打标签但未移动的会话**：这些文件仍留在活跃树里，新插件不会因为看到标签就把它们当已归档。请在 `/sessions` 里对它们重新归档一次（`ctrl+a`）。
6. **命令兼容**：`archive_session` 工具名与 `/archive` 命令保持不变，agent 侧提示词无需修改；`/archives` 不再存在，改用 `/sessions`。

## 开发

```bash
nix develop          # Node.js 24 + git 的 devShell
npm ci               # 安装依赖
npm test             # node --test，运行所有包的测试
npm run typecheck    # tsc --noEmit
```

也可以不进入 shell 直接执行：`nix develop -c npm test`。

若宿主导出了 `NODE_ENV=production`，`npm install` 会跳过 devDependencies，导致 `tsc` 与测试缺失，去掉该变量即可：

```bash
nix develop -c env -u NODE_ENV npm install
```

源码结构：

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 扩展入口：注册命令、工具与 `session_start` / `session_shutdown` 钩子 |
| `src/commands.ts` | `/sessions` 命令、picker 接线、归档/恢复动作与提示文案 |
| `src/picker.ts` | TUI picker 组件：渲染与按键映射，不碰文件系统 |
| `src/picker-state.ts` | 与界面无关的选择状态机：筛选、排序、作用域、展开、归档动作判定 |
| `src/sessions.ts` | 加载活跃与归档会话、合并去重、按 `parentSession` 建树 |
| `src/archive.ts` | 文件级原语：子树发现、伴生文件、尾部续写、标签剥除、整树归档/恢复 |
| `src/paths.ts` | 路径、目录名、标题与 session header 读取 |
| `src/state.ts` | `index.json` 与 `pi-sessions-state.json` 的读写 |
| `src/search.ts` | 查询解析与相关性排序 |
| `src/types.ts` | 共享类型 |

## 手动验收清单

自动化测试覆盖了纯逻辑、文件移动与命令层；以下交互步骤需要真实终端与模型会话，发布前请手动确认：

1. `nix develop -c pi -e ./packages/pi-sessions` 启动后，`/sessions` 能打开 picker，原生 `/resume` 仍可用。
2. 在一个测试项目里新建会话并对话，`/sessions` 选中它按 `ctrl+a` → 提示 `Session will be archived when it closes`；退出 pi 后文件从 `~/.pi/agent/sessions/<cwd-slug>/` 移到 `~/.pi/agent/sessions-archive/<cwd-slug>/`，`index.json` 出现该条目且 `archivedAt` 为当前时间。
3. 在同一目录重新启动 pi，`/sessions` 按 `ctrl+t` 切到 `archived` 能看到该行（带 `[archived]`）；按 `enter` 后文件回到 `sessions/<cwd-slug>/`，界面切到该会话。
4. 归档当前会话后执行 `/reload`：文件不移动，`pi-sessions-state.json` 里的 `pendingArchive` 仍在；之后退出 pi（或 `/new`、切换到别的会话）才移动。
5. 未命名会话：不带 `/name` 建会话，从 picker 归档并退出；归档文件与 `index.json` 中不出现 `[ARCHIVE]`，picker 与原生 `/resume` 里显示的首条消息为标题。
6. 派生会话：用 `pi-subagents` 跑一个子代理会话或执行 `/fork`，再对父会话 `ctrl+a` → 确认框显示派生会话数；归档后父与子的 `.jsonl` 都在 `sessions-archive/<cwd-slug>/`，原生 `/resume` 里不再出现孤立子会话。

## License

MIT，见 [`LICENSE`](LICENSE)。

归档目录布局、伴生文件处理、尾部续写合并与旧标签剥除改编自 [`@clementprevot/pi-session-archive`](https://github.com/clementprevot/pi-session-archive)（MIT，Copyright (c) 2026 Clément Prévot），完整声明见包内 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。本项目与上游作者没有隶属或背书关系。
