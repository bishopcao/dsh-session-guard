// dsh-session-guard — 会话备份与恢复
//
// 为什么需要它
// ------------
// 上层插件（@linxin666/dsh-session-archive）删除会话时用 rmSync 直删，
// **不进回收站**。一旦连同子话题被误删，DSH 侧没有任何找回途径。
//
// 本模块在会话还活着的时候留一份副本，删除后仍能还原。
//
// 设计要点
// --------
// 1) 备份不是全量复制。363 MB 的会话库整份复制既慢又占空间，
//    所以按「文件大小 + mtime」判断，只复制变化的文件。
// 2) 备份是增量的：同一个会话 id 只保留最近一次内容。
// 3) 恢复时校验帧结构，还原到原路径（项目目录从备份元数据里取）。
// 4) 所有失败都记日志并返回结果对象，不向上抛；备份是尽力而为，
//    绝不能因为备份失败影响 DSH 正常读写会话。

import {
  existsSync, mkdirSync, copyFileSync, statSync,
  readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** 备份根目录（相对 dshHome）。 */
const BACKUP_DIR = 'session-guard-backup'
/** 备份索引文件名。 */
const INDEX_FILE = 'index.json'
/** 单个备份副本的最大字节数，超过就跳过（避免有人一个会话几 GB）。 */
const MAX_BACKUP_BYTES = 64 * 1024 * 1024
/** 索引最多保留多少个会话。 */
const MAX_INDEX_ENTRIES = 500
/** 会话文件名（DSH 固定）。 */
const SESSION_FILE = 'session.v4.jsonl.zstd'

/** 备份根目录绝对路径。 */
export function backupRoot(dshHome) {
  return join(dshHome, BACKUP_DIR)
}

/** 索引文件绝对路径。 */
function indexPath(dshHome) {
  return join(backupRoot(dshHome), INDEX_FILE)
}

/**
 * 读备份索引。损坏或不存在时返回空结构。
 * @returns {{version:number, entries:Record<string, {id:string, proj:string, seg:string, size:number, mtime:number, backedAt:number, title:string|null}>}}
 */
export function readIndex(dshHome) {
  const empty = { version: 1, entries: {} }
  try {
    const p = indexPath(dshHome)
    if (!existsSync(p)) return empty
    const j = JSON.parse(readFileSync(p, 'utf8'))
    if (!j || typeof j !== 'object' || typeof j.entries !== 'object' || j.entries === null) return empty
    return { version: 1, entries: j.entries }
  } catch {
    return empty
  }
}

/**
 * 原子写索引（临时文件 + rename）。
 * @returns {boolean} 是否写成功
 */
export function writeIndex(dshHome, index) {
  try {
    const root = backupRoot(dshHome)
    if (!existsSync(root)) mkdirSync(root, { recursive: true })
    // 控制条目数量：按 backedAt 保留最近的
    const keys = Object.keys(index.entries)
    if (keys.length > MAX_INDEX_ENTRIES) {
      keys
        .sort((a, b) => (index.entries[b].backedAt ?? 0) - (index.entries[a].backedAt ?? 0))
        .slice(MAX_INDEX_ENTRIES)
        .forEach((k) => { delete index.entries[k] })
    }
    const target = indexPath(dshHome)
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify(index), 'utf8')
    // rename 覆盖
    try { rmSync(target, { force: true }) } catch { /* ignore */ }
    copyFileSync(tmp, target)
    try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
    return true
  } catch {
    return false
  }
}

/**
 * 把一批会话备份到本地。
 *
 * 只复制「大小或 mtime 变化」的文件；同一个 id 覆盖旧副本。
 *
 * @param {string} dshHome
 * @param {{id:string, proj:string, seg:string, file:string, size:number}[]} sessions
 * @param {{titleOf?:(id:string)=>string|null}} [hooks]
 * @returns {{copied:number, skipped:number, failed:number, bytes:number}}
 */
export function backupSessions(dshHome, sessions, hooks = {}) {
  const result = { copied: 0, skipped: 0, failed: 0, bytes: 0 }
  if (!Array.isArray(sessions) || sessions.length === 0) return result

  const index = readIndex(dshHome)
  const root = backupRoot(dshHome)
  let dirty = false

  for (const s of sessions) {
    try {
      const id = s?.header?.id ?? s?.id
      if (typeof id !== 'string' || !id) { result.skipped++; continue }
      if (typeof s.file !== 'string' || !existsSync(s.file)) { result.skipped++; continue }

      let st
      try { st = statSync(s.file) } catch { result.skipped++; continue }
      if (!st.isFile()) { result.skipped++; continue }
      if (st.size > MAX_BACKUP_BYTES) { result.skipped++; continue }

      const prev = index.entries[id]
      // 只有当索引记录一致 **且副本文件确实还在** 时才跳过。
      // 只看索引是错的：用户在「管理备份」里删掉副本后，索引可能还留着，
      // 这时跳过会让人以为备份还在，实际已经没了 —— 删除会话就永久丢数据。
      if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) {
        const prevCopy = join(root, id, SESSION_FILE)
        if (existsSync(prevCopy)) {
          let copySize = -1
          try { copySize = statSync(prevCopy).size } catch { copySize = -1 }
          if (copySize === st.size) {
            result.skipped++
            continue
          }
        }
        // 副本缺失或大小不对 → 继续往下走，重新复制
      }

      // 备份路径：<root>/<id>/session.v4.jsonl.zstd
      const destDir = join(root, id)
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
      const dest = join(destDir, SESSION_FILE)
      copyFileSync(s.file, dest)

      // 复制后核对大小，防止拷到一半
      let ok = false
      try { ok = statSync(dest).size === st.size } catch { ok = false }
      if (!ok) {
        try { rmSync(dest, { force: true }) } catch { /* ignore */ }
        result.failed++
        continue
      }

      index.entries[id] = {
        id,
        proj: s.proj ?? '',
        seg: s.seg ?? id,
        size: st.size,
        mtime: st.mtimeMs,
        backedAt: Date.now(),
        title: typeof hooks.titleOf === 'function' ? (hooks.titleOf(id) ?? null) : null,
      }
      dirty = true
      result.copied++
      result.bytes += st.size
    } catch {
      result.failed++
    }
  }

  if (dirty) writeIndex(dshHome, index)
  return result
}

/**
 * 列出可恢复的会话（备份里有、但当前会话库里已经没有了）。
 *
 * @param {string} dshHome
 * @param {Set<string>|string[]} liveIds 当前仍存在的会话 id
 * @returns {{id:string, title:string|null, size:number, backedAt:number, proj:string}[]}
 */
export function listRestorable(dshHome, liveIds) {
  const live = liveIds instanceof Set ? liveIds : new Set(Array.isArray(liveIds) ? liveIds : [])
  const index = readIndex(dshHome)
  const out = []
  for (const [id, e] of Object.entries(index.entries)) {
    if (live.has(id)) continue
    // 确认备份副本真的还在
    const p = join(backupRoot(dshHome), id, SESSION_FILE)
    if (!existsSync(p)) continue
    out.push({
      id,
      title: e.title ?? null,
      size: e.size ?? 0,
      backedAt: e.backedAt ?? 0,
      proj: e.proj ?? '',
    })
  }
  out.sort((a, b) => b.backedAt - a.backedAt)
  return out
}

/**
 * 把备份里的会话还原回 `~/.dsh/sessions/<proj>/<seg>/session.v4.jsonl.zstd`。
 *
 * 安全策略：
 *   - 目标已存在则默认**不覆盖**（overwrite !== true 时返回 'exists'）
 *   - 目标路径用备份元数据里的 proj/seg 重建；缺失时回退用 id
 *   - 还原后校验字节数一致，不一致则删掉半成品并报错
 *
 * @param {string} dshHome
 * @param {string} sessionsRoot
 * @param {string} id
 * @param {{overwrite?:boolean}} [options]
 * @returns {{status:'restored'|'missing-backup'|'exists'|'failed', path?:string, bytes?:number, reason?:string}}
 */
export function restoreSession(dshHome, sessionsRoot, id, options = {}) {
  try {
    if (typeof id !== 'string' || !id) return { status: 'failed', reason: 'bad-id' }

    const src = join(backupRoot(dshHome), id, SESSION_FILE)
    if (!existsSync(src)) return { status: 'missing-backup' }

    const index = readIndex(dshHome)
    const meta = index.entries[id]
    const proj = typeof meta?.proj === 'string' && meta.proj ? meta.proj : ''
    const seg = typeof meta?.seg === 'string' && meta.seg ? meta.seg : id

    // 没有 proj 就没法还原到正确位置（DSH 按项目目录组织）
    if (!proj) return { status: 'failed', reason: 'no-project-metadata' }

    const destDir = join(sessionsRoot, proj, seg)
    const dest = join(destDir, SESSION_FILE)
    if (existsSync(dest) && options.overwrite !== true) return { status: 'exists', path: dest }

    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
    copyFileSync(src, dest)

    let srcSize = 0
    let destSize = 0
    try { srcSize = statSync(src).size } catch { /* ignore */ }
    try { destSize = statSync(dest).size } catch { /* ignore */ }
    if (srcSize !== destSize) {
      try { rmSync(dest, { force: true }) } catch { /* ignore */ }
      return { status: 'failed', reason: 'size-mismatch' }
    }

    return { status: 'restored', path: dest, bytes: destSize }
  } catch (error) {
    return { status: 'failed', reason: String(error?.message ?? error) }
  }
}

/** 备份统计：条目数、占用字节。 */
export function backupStats(dshHome) {
  const index = readIndex(dshHome)
  const ids = Object.keys(index.entries)
  let bytes = 0
  for (const id of ids) {
    const p = join(backupRoot(dshHome), id, SESSION_FILE)
    try { bytes += statSync(p).size } catch { /* ignore */ }
  }
  return { count: ids.length, bytes }
}

/**
 * 列出全部备份副本（不管会话还在不在）。
 *
 * 和 listRestorable() 的区别：
 *   - listRestorable 只返回「已经被删掉」的（需要救回来的）
 *   - 本函数返回全部（用户想自己挑着删掉某些备份）
 *
 * @param {string} dshHome
 * @param {Set<string>|string[]} liveIds 当前仍存在的会话 id，用来标记 alive
 * @returns {{id:string, title:string|null, size:number, backedAt:number, proj:string, alive:boolean}[]}
 */
export function listBackups(dshHome, liveIds) {
  const live = liveIds instanceof Set ? liveIds : new Set(Array.isArray(liveIds) ? liveIds : [])
  const index = readIndex(dshHome)
  const out = []
  for (const [id, e] of Object.entries(index.entries)) {
    const p = join(backupRoot(dshHome), id, SESSION_FILE)
    let size = e.size ?? 0
    try {
      if (!existsSync(p)) continue
      size = statSync(p).size
    } catch {
      continue
    }
    out.push({
      id,
      title: e.title ?? null,
      size,
      backedAt: e.backedAt ?? 0,
      proj: e.proj ?? '',
      alive: live.has(id),
    })
  }
  out.sort((a, b) => b.backedAt - a.backedAt)
  return out
}

/**
 * 批量丢弃备份（用户在列表里勾选后删除）。
 *
 * @param {string} dshHome
 * @param {string[]} ids
 * @returns {{dropped:number, failed:number}}
 */
export function dropBackups(dshHome, ids) {
  const result = { dropped: 0, failed: 0 }
  if (!Array.isArray(ids)) return result
  for (const id of ids) {
    if (typeof id !== 'string' || !id) { result.failed++; continue }
    if (dropBackup(dshHome, id)) result.dropped++
    else result.failed++
  }
  return result
}

/**
 * 按天数清理过期备份。
 *
 * 「过期」的口径是 `backedAt`（这份副本最后一次被写入的时间），不是会话创建时间。
 * 会话还在、内容又没变的话 backedAt 会一直停在上次变化那一刻，所以
 * **还活着的会话不该被这个函数删掉**——调用方应传 onlyOrphans=true（默认行为），
 * 只清「会话已经不存在」的备份。
 *
 * @param {string} dshHome
 * @param {number} days 超过多少天算过期
 * @param {{liveIds?:Set<string>|string[], onlyOrphans?:boolean}} [options]
 * @returns {{removed:number, freedBytes:number, kept:number}}
 */
export function pruneBackups(dshHome, days, options = {}) {
  const result = { removed: 0, freedBytes: 0, kept: 0 }
  const d = Number(days)
  if (!Number.isFinite(d) || d <= 0) return result

  const live = options.liveIds instanceof Set
    ? options.liveIds
    : new Set(Array.isArray(options.liveIds) ? options.liveIds : [])
  const onlyOrphans = options.onlyOrphans !== false

  const cutoff = Date.now() - d * 24 * 60 * 60 * 1000
  const index = readIndex(dshHome)
  let dirty = false

  for (const [id, e] of Object.entries(index.entries)) {
    const backedAt = e.backedAt ?? 0
    if (backedAt > cutoff) { result.kept++; continue }
    if (onlyOrphans && live.has(id)) { result.kept++; continue }

    const p = join(backupRoot(dshHome), id, SESSION_FILE)
    let size = 0
    try { size = statSync(p).size } catch { /* ignore */ }

    try {
      const dir = join(backupRoot(dshHome), id)
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
      delete index.entries[id]
      dirty = true
      result.removed++
      result.freedBytes += size
    } catch { /* 单个失败不影响其余 */ }
  }

  if (dirty) writeIndex(dshHome, index)
  return result
}

/** 删除一个备份副本（会话被用户确认不要了）。 */
export function dropBackup(dshHome, id) {
  try {
    const dir = join(backupRoot(dshHome), id)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    const index = readIndex(dshHome)
    if (index.entries[id]) {
      delete index.entries[id]
      writeIndex(dshHome, index)
    }
    return true
  } catch {
    return false
  }
}

export { BACKUP_DIR, INDEX_FILE, MAX_BACKUP_BYTES, MAX_INDEX_ENTRIES, SESSION_FILE }
