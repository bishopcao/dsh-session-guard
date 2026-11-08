// dsh-session-guard — 解除记录（持久化 + 自动清理）
//
// 设计目标
// --------
// UI 上要能看到「自动独立了哪些会话」。记录存成 JSON 文件放在 $DSH_HOME。
//
// 关键要求：**记录跟着会话走**。
// 核对当前会话目录里的实际文件：
//   - 会话已不存在        → 这条记录自动删掉（会话被删了，记录没有意义）
//   - parentSession 恢复  → 会话被回滚过，旧记录失效
// 这样记录不会无限堆积，也不会显示已经不存在的会话。
//
// ── 健壮性要点（2026-11-02 审查后修正）────────────────────────────────
//
// 1) 批量追加走 appendRecords()，一次读、一次写。
//    早先每个会话调一次 appendRecord，批量解除 N 个就读写文件 N 次。
//
// 2) 写入失败不再静默：writeRecords 返回 false，appendRecords 把它交回调用方，
//    由上层决定是否告警。之前失败时悄悄返回旧数据，记录丢了没人知道。
//
// 3) pruneRecords 支持 dirty 标记：没删任何记录时不重写文件，避免无谓 IO。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_RECORDS = 200
const STORE_FILE = 'session-guard-records.json'

function storePath(dshHome) {
  return join(dshHome, STORE_FILE)
}

/**
 * 读取全部记录（未做存活校验的原始数据）。
 * @returns {{version:number, records:Array}}
 */
export function readRecords(dshHome) {
  try {
    const raw = readFileSync(storePath(dshHome), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.records)) return { version: 1, records: [] }
    return { version: 1, records: parsed.records }
  } catch {
    return { version: 1, records: [] }
  }
}

/**
 * 原子写入（临时文件 + rename）。
 * @returns {boolean} 是否写入成功。失败时调用方必须知道。
 */
export function writeRecords(dshHome, records) {
  try {
    const target = storePath(dshHome)
    mkdirSync(dshHome, { recursive: true })
    const temp = `${target}.tmp`
    const payload = JSON.stringify({ version: 1, records }, null, 2)
    writeFileSync(temp, payload + '\n', 'utf8')
    renameSync(temp, target)
    return true
  } catch {
    return false
  }
}

/** 统一一条记录的形状，过滤掉不完整的输入。 */
function normalize(entry) {
  if (!entry || typeof entry.id !== 'string' || !entry.id) return null
  return {
    id: entry.id,
    title: typeof entry.title === 'string' ? entry.title : null,
    parentSession: typeof entry.parentSession === 'string' ? entry.parentSession : null,
    parentTitle: typeof entry.parentTitle === 'string' ? entry.parentTitle : null,
    at: typeof entry.at === 'number' ? entry.at : Date.now(),
    source: entry.source === 'manual' ? 'manual' : 'auto',
  }
}

/**
 * 批量追加记录：一次读、一次写。
 *
 * @param {string} dshHome
 * @param {Array<object>} entries
 * @returns {{ok:boolean, records:Array, added:number}}
 */
export function appendRecords(dshHome, entries) {
  const incoming = (entries ?? []).map(normalize).filter(Boolean)
  if (incoming.length === 0) {
    return { ok: true, records: readRecords(dshHome).records, added: 0 }
  }

  const { records } = readRecords(dshHome)
  // 新记录优先；同一会话只保留最新一条
  const incomingIds = new Set(incoming.map((r) => r.id))
  const kept = records.filter((r) => !incomingIds.has(r.id))
  const merged = [...incoming, ...kept].slice(0, MAX_RECORDS)

  const ok = writeRecords(dshHome, merged)
  return { ok, records: ok ? merged : records, added: ok ? incoming.length : 0 }
}

/** 追加单条（内部转调批量）。 */
export function appendRecord(dshHome, entry) {
  return appendRecords(dshHome, [entry])
}

/**
 * 按当前磁盘状态清理记录。
 *
 * 一条记录被删掉的条件（任一成立）：
 *   1. 该会话已不在 sessions 列表里 —— 会话被删了
 *   2. 该会话又有 parentSession 了 —— 被回滚/重新 fork 过，旧记录失效
 *
 * 记录顺序以磁盘上的 records 为准（新→旧），不排序。
 *
 * @param {string} dshHome
 * @param {Array} sessions scanSessions() 的结果
 * @param {object} [options]
 * @param {boolean} [options.persist] 是否把清理结果写回磁盘，默认 true
 * @returns {{alive:Array, removed:number, writeOk:boolean}}
 */
export function pruneRecords(dshHome, sessions, options = {}) {
  const persist = options.persist !== false
  const { records } = readRecords(dshHome)

  const byId = new Map()
  for (const s of sessions) {
    // 防御：调用方可能传入结构不完整的元素
    const id = s?.header?.id
    if (typeof id === 'string' && id) byId.set(id, s)
  }

  const alive = []
  for (const r of records) {
    const live = byId.get(r.id)
    if (!live) continue                                   // 会话没了
    if (live.header.parentSession !== undefined) continue // 又有父关系了
    alive.push(r)
  }

  const removed = records.length - alive.length
  let writeOk = true
  // 只有确实删掉了才回写，避免无意义的 IO
  if (persist && removed > 0) writeOk = writeRecords(dshHome, alive)
  return { alive, removed, writeOk }
}

/** 清空全部记录。 */
export function clearRecords(dshHome) {
  return writeRecords(dshHome, [])
}

export { MAX_RECORDS, STORE_FILE }
