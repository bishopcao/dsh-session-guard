# dsh-session-guard

**Stop DSH from deleting your conversations when you delete a parent topic — and get them back if it happens anyway.**

[中文说明](./说明.md)

---

## The problem

DeepSeek Harness lets you branch a conversation (`Ctrl+Alt+F`). The child records its origin in `parentSession`, and the session-archive plugin treats every child as a disposable descendant: delete the parent, and the whole family is removed with `rmSync` — **straight to disk, no recycle bin**.

So one "clean up archived topics" click can silently destroy conversations you never archived.

## What this plugin does

Two lines of defense, plus a safety net.

### 1. Prevent — detach the link the moment a branch exists

`session/created` fires as soon as a branch is created. The plugin clears `parentSession` in the session header **before the relationship can ever matter**. Deleting a parent can no longer reach a child, because in the data the child is no longer its descendant.

A startup sweep handles anything created before the plugin was installed.

**Subagent sessions are never touched** — their parent links are a legitimate runtime structure.

### 2. Recover — keep a local copy

Even with prevention in place, other things delete sessions. So the plugin keeps an incremental backup of every live session under `~/.dsh/session-guard-backup/`.

- First run copies everything (275 sessions / 549 MB took 573 ms on a real install)
- Later runs only copy files whose size or mtime changed (38 ms)
- Deleted sessions show up in the restore list and can be put back byte-for-byte

---

## Install

```bash
dsh plugin --profile desktop add dsh-session-guard
```

Or add it to `~/.dsh/profiles/<profile>/package.json`:

```json
{
  "dependencies": { "dsh-session-guard": "1.0.0" },
  "dsh": { "profile": { "bundles": ["dsh-session-guard"] } }
}
```

Restart DSH afterwards.

## Configuration

`cordis.patch.yml`:

```yaml
- insert:
    - id: session-guard
      name: dsh-session-guard
      config:
        autoDetachOnMount: true   # detach historic forks at startup
        backupOnMount: true       # incremental backup at startup
```

Both also have runtime toggles in the plugin card.

---

## Where you see it

**Sidebar icon** (盾牌) — opens the full panel in the main area.

**Plugin card** (`Plugins` page → `dsh-session-guard`)
- Auto-detach switch
- Recent detach records (auto-deleted when the session is gone), paginated
- **Data audit** — find session files that are corrupt, half-deleted or unreadable
- **Orphaned subagents** — sessions whose parent is already gone, with a one-click cleanup
- Backup management: 现存 / 已删除 tabs, pagination, per-page size, restore, delete
- **Delete sessions** — cascades to subagent and fork descendants

**Conversation header** — a badge showing whether the current conversation is detached.

**Session menu** (`⋯` on any conversation) — adds **删除会话** (trash icon). Deletion is
backed up first, so it stays recoverable.

**Sidebar icon list** — a 「收起部分 ▼ / 展开全部 ▲」 toggle sits above the panel icons.
Collapsing shortens the list rather than hiding it: the first N icons stay visible and the
rest scroll. Right-click the toggle to pick N (1–6, default 4); the choice and the collapsed
state both persist across restarts.

---

## Tools

### `dsh_session_lineage`

Read-only. Reports total sessions, real-dialog forks still at risk, and dangling parent references.

```
会话总数: 275
真实对话 fork（删除时会被连带带走）: 0
悬空引用（父已不存在）: 0
```

### `dsh_detach_sessions`

Dry run by default; pass `confirm=true` to write. Every changed file is backed up under its session directory and verified after writing.

```
{ "sessionId": "session-abc12345" }   # one session
{ "all": true }                       # every real-dialog fork
{ "confirm": true }                   # actually write
```

---

## HTTP API

The browser half talks to these through `/session-guard`:

| Method | Path | Purpose |
|---|---|---|
| GET | `/state` | Switch state, stats, recent records, orphaned subagents |
| GET | `/audit` | Sessions that cannot be read, with the reason for each |
| GET | `/restorable` | Backed-up sessions that no longer exist |
| GET | `/backups` | Backup list — `filter=alive\|deleted`, `limit`, `offset` |
| POST | `/toggle` | `{ enabled: boolean }` |
| POST | `/detach` | `{ sessionId? }` |
| POST | `/delete` | `{ sessionId \| sessionIds, confirm?, cascade? }` — dry run unless `confirm: true` |
| POST | `/backup` | Run an incremental backup now |
| POST | `/restore` | `{ sessionId, overwrite? }` |
| POST | `/drop-backup` | `{ sessionId }` |
| POST | `/drop-backups` | `{ sessionIds }` |
| POST | `/prune-backups` | Drop backups older than the retention window |
| POST | `/settings` | `{ retentionDays }` |
| POST | `/clear` | Clear detach records |

---

## How it writes safely

Clearing `parentSession` means rewriting frame 0 of a zstd multi-frame file while DSH may be appending to it. The rules:

1. **Parse frames properly.** Not "find the second magic number" — read the frame header, walk the blocks to `lastBlock`, skip the checksum. DSH does the same in `scanZstdFrames`.
2. **Match DSH's compression parameters.** DSH writes frames with `ZSTD_c_checksumFlag: 1`; the replacement frame does too.
3. **Detect concurrent appends.** The whole file is re-read and compared before writing. Any change since the snapshot means another writer is active — the write is abandoned, never forced.
4. **Verify after writing.** Event bytes must be identical to the pre-write snapshot. On mismatch the original file is restored from the backup taken seconds earlier.

Statuses: `detached` · `already` · `busy` · `failed` · `conflict` · `planned`.

---

## Scope and limits

- **Only real conversations.** `origin === "subagent"` sessions are skipped.
- **Deleting a parent still deletes the parent.** This plugin removes the *cascade*, not the delete.
- **Only `parentSession` is cleared.** Fork history, event log, and titles are untouched.
- **The backup is a copy, not a version history.** One copy per session id, overwritten when the session changes.
- **Restore needs the project directory.** Backups record which project a session came from; without it the plugin refuses to guess a path.

---

## License

MIT. See [LICENSE](./LICENSE).
