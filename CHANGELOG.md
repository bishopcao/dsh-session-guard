# Changelog

All notable changes to this project.

## [1.0.7] — 2026-11-10

### Fixed — 删除后界面三处不同步（这一版彻底解决）

前几版删除会话只做了物理删除，界面和 Host 状态全都停留在旧视图，
导致三种症状：列表里删不掉、发消息报 ENOENT、主面板停在已删的会话上。

逐个修掉：

**① 侧边栏列表不消失**

DSH 的列表读的是 Host 内存里的会话快照，不是磁盘。直接 `rmSync`
造成「磁盘已删、Host 仍认为活着」，于是不仅列表删不掉，给那个会话发消息
还会 `ENOENT: no such file or directory`。

现在删除前先走 DSH 自己的归档通道：

```js
workspaceRegistry.archiveSession(id)   // 写 archivedSessionIds 并持久化
rmSync(dir)                            // 再物理删除
```

顺序不能反——`archiveSession` 内部会校验会话是否还存在
（`dsh-workspace/lib/index.js:529`），文件删掉之后它会抛
`WorkspaceUnknownSessionError`。

归档失败就中止删除：宁可删不掉，也不留下 Host 与磁盘不一致的状态。

**② 主面板停在已删的会话上**

`archiveSession` 只摘列表，不动中央面板。原因是主面板用
`retainedBy.mainView` 引用计数持有会话，那个 reference 握在 UI 组件里，
服务层没有强制释放的公开接口。

解法是主动切走：

```js
uiWorkspace.openSession(下一个会话)
```

切换时旧引用自然释放。判断「是不是当前会话」也走官方口径
（`retainedBy.mainView > 0`，即 `dsh-client-ui-session/lib/client.js:917`
判断主视图的依据）。

**③ 服务拿不到**

`uiWorkspace` / `workspaces` 注册在客户端 root context 上，
插件拿到的是子 context，直接 `ctx.uiWorkspace` 读不到（isolate 边界会截断
fiber 链的查找）。改成四级获取：`ctx.root` 属性 → `ctx` 属性 →
`ctx.get(name, false)` → `ctx.root.get(name, false)`。

### Added — 删除决策的诊断回传

排查这类问题时，浏览器控制台往往拿不到。现在 `switchAwayIfViewing`
每一步都记 trace，通过 `POST /session-guard/diag` 上报，
后端只在内存留最近 20 条，用 `GET /session-guard/diag` 回读。

trace 会明确落在哪一步：`no-uiWorkspace` / `no-openSession` /
`not-main` / `no-next` / `open-throw:...` / `opened`。

### Changed — delete.js 三个函数改为 async

`deleteSession` / `deleteSessions` / `deleteSessionsCascade` 都改成 async，
因为归档是异步的。批量删除改为串行执行——归档走 `operationTail` 队列，
并发提交会被排队，顺序混乱时也不易定位失败。

新增返回状态 `archive-failed`，与 `backup-failed` 并列。

## [1.0.2] — 2026-11-09

### Changed — 文档改为中文为主

README 全篇重写为中文，package.json 的 description 与 keywords 也加了中文，
便于中文环境检索。代码标识符、命令、接口路径保持原文。

## [1.0.1] — 2026-11-09

### Fixed — a missing client slot killed the entire plugin

All five ctx.slots.inject calls except two were unwrapped. If the host did
not provide a slot, the throw aborted the whole actory, so the slots after
it never registered either — a build missing one slot silently lost several UI
pieces. Each slot now registers through mountSlot(), which catches and logs
per slot.

Verified with a simulated host offering 5, 4, 2 and 0 slots: the module never
throws, and every available slot still registers.

### Added — Compatibility section in the README

Records the tested DSH version, states plainly that ngines.dsh is the
version actually run rather than a verified lower bound, and tables what UI
each missing slot costs.

## [1.0.0] — 2026-11-09

First release. The three fixes below were found by a release audit and are the
reason this is 1.0.0 rather than 0.11.x.

### Fixed — tools failed to register (`must declare output { schema, render }`)

`render` had been moved to the tool's top level instead of staying inside
`output`. DSH validates `output { schema, render, presentationMeta? }` on
registration, so every `ctx.tools.register` threw:

```
tool "dsh_session_lineage" must declare output { schema, render, presentationMeta? }
```

Because Cordis swallows exceptions thrown from `apply`, the whole plugin
vanished — the UI card still rendered (client side loaded fine) while every
HTTP call returned 404. `apply` now wraps its body and logs failures to the DSH
logger instead of failing silently.

### Fixed — `readdirSync` was never imported

`liveSessionIds()` caught the resulting `ReferenceError` in a bare `catch` and
returned an empty set, so every backup looked deleted and the 现存 tab was empty.

### Fixed — scanning read entire files

`readHeader` used `readFileSync` on the whole session file to get a header of a
few hundred bytes. Across 258 sessions / 488 MB that cost 484 ms per scan.
Now reads incrementally (64 KB → 256 KB → 1 MB → 4 MB, whole file as last
resort). Verified byte-identical on all 258 real sessions: 484 ms → 110 ms.

### Changed — one scan shared by all endpoints

Opening the panel fired four requests (two `/state` from separate polling
components, plus `/backups` and `/restorable`), each running its own full scan.
A 1.2 s shared scan cache collapses them into one. Four concurrent requests:
552 ms → 243 ms. `buildState(true)` now also drops the scan cache so a write is
visible immediately instead of up to 1.2 s late.

## [0.11.0] — 2026-11-09

### Added — data audit

Scanning silently skips any session it cannot read, so a corrupt file or a half-deleted directory was invisible. `auditSessions()` walks the same layout but records **why** each session was skipped.

- `GET /audit` and a "数据体检" panel with a manual check button
- Seven reasons: `header-unreadable`, `no-session-file`, `empty-dir`, `no-id`, `id-mismatch`, `stat-failed`, `project-unreadable`
- Healthy installs show one line; problems expand into a grouped list

### Changed — sidebar icon list

- Collapsing now **shortens** the list instead of hiding it: the first N icons stay visible, the rest scroll
- N is configurable (1–6) via right-click on the toggle button, persisted in `localStorage`
- Defaults to 4 rows (160 px narrow / 184 px wide)
- Collapsed state persists across restarts

### Changed — backup list

- Split into 现存 / 已删除 tabs, 现存 first and selected by default
- Server-side pagination with 10 / 20 / 50 / 100 and a custom page size
- Page jump box on both lists
- Subagent sessions are folded into their parent and not listed; **orphans stay visible** so they can be cleaned

### Added — cascade delete

Deleting a parent now removes its subagent and fork descendants too, deepest first. `cascade: false` limits the delete to the exact ids given.

### Fixed — `readdirSync` was never imported

`liveSessionIds()` swallowed the resulting `ReferenceError` in a bare `catch`, returned an empty set, and every backup looked deleted — the 现存 tab was empty. Imported the symbol and verified the 现存 list again returns real rows.

### Fixed — backups reported success when the copy was gone

`ensureBackup` treated `skipped > 0` as success, but `skipped` only means "source unchanged". If the user had already discarded the copy, a delete went ahead with no backup at all. Both `backup.js` and `ensureBackup` now stat the copy and compare byte counts.

### Fixed — concurrent delete returned 404

A second click on an already-deleted session reported "not found". If the id exists in the backup index it now answers `200` with `deleted: 0`, which the UI reads as already handled.

### Fixed — titles missing from the deleted tab

`displayNameOf()` only consulted `projcache`, which disappears together with the session. Backup records keep the title from detach time, so it is now the first fallback. Recoverable titles went from 16 to 189 of 285.

### Fixed — sidebar flickered

A `MutationObserver` on the whole document plus `removeChild` in its callback fed back into React's own rendering. The observer is removed entirely; mounting retries a few times at startup and then stays idle.

## [0.4.0] — 2026-11-09

### Added — delete sessions

DSH has no unified delete entry; the archive plugin only stops and archives. Physical deletion is the irreversible part, so this plugin makes it reversible.

- `deleteSession()` / `deleteSessions()` in `delete.js`
- **Backup first, delete second**: if the backup copy cannot be verified, nothing is deleted
- Refuses to delete a session that is still running (an exclusive write handle exists)
- Dry run by default; `confirm: true` actually deletes
- Every deletion is recoverable from the backup

### Added — backup management

- `GET /backups` — every backup copy with size, timestamp, and whether its session still exists
- `POST /drop-backups` — discard selected backups in one call
- `POST /prune-backups` — drop backups older than N days
- `backupRetentionDays` config (default 30, `0` disables expiry)
- Startup runs expiry cleanup automatically

**Expiry only removes backups whose session is already gone.** A live session is never dropped for age — that would quietly push it out of protection.

### Fixed — detach records showed "(无标题)"

Detach happens on `session/created`, at which point DSH has not generated a title yet (titles are produced asynchronously by the session-title pipeline). The record therefore stored an empty title forever.

Records now read the title live for sessions that still exist, falling back to the stored value only when the session is gone. Verified on 46 real records: 46/46 now resolve a real title.

## [0.3.0] — 2026-11-08

### Added — restore after accidental deletion

The archive plugin deletes sessions with `rmSync`; there is no recycle bin and no undo. Prevention alone cannot cover other delete paths, so the plugin now keeps a local copy.

- `backupSessions()` — incremental copy of every live session into `~/.dsh/session-guard-backup/`
  - First run copies everything; later runs compare size + mtime and skip unchanged files
  - Measured on a real install: 275 sessions / 549 MB in 573 ms, second run 38 ms
- `listRestorable()` — find backed-up sessions that no longer exist on disk
- `restoreSession()` — put a session back at its original path, verified byte-for-byte
  - Refuses to overwrite an existing file unless `overwrite: true`
  - Refuses to guess when the project directory is unknown
- `dropBackup()` / `backupStats()` — cleanup and reporting

### Added — HTTP endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/restorable` | backed-up sessions that are gone |
| POST | `/backup` | run an incremental backup now |
| POST | `/restore` | restore one session |
| POST | `/drop-backup` | discard one backup |

### Added — startup self-check and config

- `backupOnMount` (default `true`) — incremental backup at startup
- Startup logs now report how many sessions were copied / skipped / failed

### Fixed — GET routes returned 405

`GET /restorable` was unreachable: the method guard (`if (req.method !== 'POST') return 405`) ran before every GET branch. All GET endpoints are now handled in one block ahead of the guard.

### Fixed — `render` returned an object instead of an array

DSH consumes a tool result as `content` and calls `content.some(...)`. Both tools returned a bare `{ type: 'text', text }`, which threw `content.some is not a function` on every call. Now returns `[{ type: 'text', text }]`.

### Fixed — early returns violated the output schema

`dsh_detach_sessions` has three early-return branches that returned only `{ text }`, while `output.schema.required` lists `text`, `dryRun`, `counts`. DSH validates results against that schema, so those paths failed. A shared `early()` helper now fills all three fields.

### Performance — detach on create: 260 ms → 1 ms

`session/created` used to call `scanSessions()` and then `.find()` one id — reading the header of every session file (199 files / 260 ms) to locate a single session, on every new conversation and every branch.

- `findSessionById()` locates a session by directory name, reading only the file it hits
- `findSessionByIdWithFallback()` falls back to the full scan when the fast path misses, so the worst case is exactly the old behaviour
- Verified on 199 real sessions: identical path and header for all of them, 208× faster
- Exported from `core.js`; not exported from the package (`./core` stays the public surface)

## [0.2.0] — 2026-11-02

### Fixed

- `tools.*.parameters` were flat objects. DSH accepted them but forwarded them verbatim, so strict gateways (TRAE) rejected the request with `tools.N.function.parameters must be a JSON Schema of type object`. Both tools now emit a standard schema with `type`/`properties`/`required`.
- `detachSession(undefined)`, `realDialogForks(null)`, `danglingForks(null)`, `lineageTree(null)` and `pruneRecords` with a null header all threw. Every entry point now type-checks and returns a failure status.

### Added

- Three-layer race protection: snapshot consistency check, whole-file comparison before writing, event-byte verification after writing
- 3-second state cache — the UI polls two components every 5 s and each poll scanned every session file

## [0.1.0] — 2026-11-02

### Added

- `session/created` hook and startup sweep that clear `parentSession` on real-dialog forks
- `dsh_session_lineage` and `dsh_detach_sessions` tools
- Plugin card and conversation header badge
- Detach records under `~/.dsh/`
