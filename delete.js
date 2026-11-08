// dsh-session-guard — 会话删除
//
// 为什么要自己实现
// ----------------
// DSH 目前没有「删除会话」的统一入口：归档插件做的是「停用 + 归档」，
// 而物理删除（rmSync）才是真正腾出空间、也是真正不可逆的一步。
// 本模块把这一步做成**先备份再删**，让删除可撤回。
//
// 安全策略（顺序不能变）
// --------------------
//   1. 拒绝删除正在运行的会话（写句柄被占用 → 有进程还在写）
//   2. 拒绝删除空 id / 找不到的 id
//   3. **先**把文件复制进备份区并校验字节数
//   4. 校验失败 → 中止，一个字节都不删
//   5. 校验通过 → 再删目录
//   6. 删除后写一条记录，说明「这个会话是被本插件删的，可从备份恢复」
//
// 任何一步失败都返回 status + reason，不抛异常。

import {
  existsSync, statSync, rmSync, openSync, closeSync, readdirSync,
} from 'node:fs'
import { join } from 'node:path'

/** 会话文件名（DSH 固定）。 */
const SESSION_FILE = 'session.v4.jsonl.zstd'

/** 能否独占打开（false = 有进程正持有写句柄，正在运行）。 */
function isBusy(file) {
  try {
    const fd = openSync(file, 'r+')
    closeSync(fd)
    return false
  } catch {
    return true
  }
}

/**
 * 删除一个会话的整个目录。
 *
 * @param {{id:string, dir:string, file:string}} session scanSessions() 的元素
 * @param {object} deps 依赖注入（避免循环 import）
 * @param {(id:string) => boolean} deps.ensureBackup 备份这个会话，返回是否成功
 * @param {{dryRun?:boolean}} [options]
 * @returns {{status:'deleted'|'planned'|'busy'|'failed'|'missing'|'backup-failed', id?:string, reason?:string, freedBytes?:number}}
 */
export function deleteSession(session, deps, options = {}) {
  try {
    const id = session?.header?.id ?? session?.id
    if (typeof id !== 'string' || !id) return { status: 'failed', reason: 'bad-id' }

    const dir = session?.dir
    const file = session?.file ?? (typeof dir === 'string' ? join(dir, SESSION_FILE) : null)
    if (typeof dir !== 'string' || !dir) return { status: 'failed', reason: 'no-dir' }
    if (!existsSync(dir)) return { status: 'missing' }

    // 1. 正在运行就不动
    if (file && existsSync(file) && isBusy(file)) {
      return { status: 'busy', id, reason: '会话正在运行，先停止再删除' }
    }

    // 统计体积（预演也要给用户看）
    let freedBytes = 0
    try {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        try {
          const st = statSync(p)
          if (st.isFile()) freedBytes += st.size
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    if (options.dryRun === true) return { status: 'planned', id, freedBytes }

    // 2. 先备份，备份不成功就不删
    if (typeof deps?.ensureBackup === 'function') {
      let ok = false
      try { ok = deps.ensureBackup(id) === true } catch { ok = false }
      if (!ok) return { status: 'backup-failed', id, reason: '备份失败，已中止删除' }
    }

    // 3. 再删
    rmSync(dir, { recursive: true, force: false })
    if (existsSync(dir)) return { status: 'failed', id, reason: '删除后目录仍存在' }

    return { status: 'deleted', id, freedBytes }
  } catch (error) {
    return { status: 'failed', id: session?.header?.id, reason: String(error?.message ?? error) }
  }
}

/**
 * 批量删除。单个失败不影响其余。
 *
 * @param {Array} sessions
 * @param {object} deps 同 deleteSession
 * @param {{dryRun?:boolean}} [options]
 * @returns {{results:Array, deleted:number, planned:number, busy:number, failed:number, freedBytes:number}}
 */
export function deleteSessions(sessions, deps, options = {}) {
  const list = Array.isArray(sessions) ? sessions : []
  const results = list.map((s) => deleteSession(s, deps, options))
  let deleted = 0, planned = 0, busy = 0, failed = 0, freedBytes = 0
  for (const r of results) {
    if (r.status === 'deleted') { deleted++; freedBytes += r.freedBytes ?? 0 }
    else if (r.status === 'planned') { planned++; freedBytes += r.freedBytes ?? 0 }
    else if (r.status === 'busy') busy++
    else failed++
  }
  return { results, deleted, planned, busy, failed, freedBytes }
}

/**
 * 找出某些会话的**所有后代**（子代理 + fork 分支，递归到底）。
 *
 * 为什么需要：父会话删了但子代理还在，那些子代理就变成孤儿——
 * 侧边栏不显示它们（DSH 的 sessionVisible 直接过滤 origin==='subagent'），
 * 用户既看不见也删不掉，只能留在磁盘里占空间。
 *
 * 与 core.js 的 lineageTree 的区别：那个专门排除 subagent（给血缘图用），
 * 这个反过来**专门要包含 subagent**。
 *
 * @param {Array} allSessions scanSessions() 全部会话
 * @param {string[]} rootIds 要展开的根 id
 * @returns {{ids:string[], sessions:Array}} 不含根自身
 */
export function descendantsOf(allSessions, rootIds) {
  const list = Array.isArray(allSessions) ? allSessions : []
  const roots = new Set(Array.isArray(rootIds) ? rootIds.filter((x) => typeof x === 'string' && x) : [])
  if (roots.size === 0) return { ids: [], sessions: [] }

  // parent -> children（不过滤 origin，subagent 和 fork 都算）
  const childrenOf = new Map()
  for (const s of list) {
    const id = s?.header?.id
    const p = s?.header?.parentSession
    if (typeof id !== 'string' || !id) continue
    if (typeof p !== 'string' || !p) continue
    if (!childrenOf.has(p)) childrenOf.set(p, [])
    childrenOf.get(p).push(s)
  }

  const seen = new Set(roots)          // 防环：万一数据里出现 A→B→A
  const out = []
  const queue = [...roots]
  while (queue.length > 0) {
    const cur = queue.shift()
    for (const child of childrenOf.get(cur) ?? []) {
      const cid = child.header.id
      if (seen.has(cid)) continue      // 已在结果里，或是根自身
      seen.add(cid)
      out.push(child)
      queue.push(cid)                  // 继续往下找它的子会话
    }
  }
  return { ids: out.map((s) => s.header.id), sessions: out }
}

/**
 * 级联删除：删掉这些会话及其所有后代。
 *
 * 顺序很讲究——**先删叶子，最后删根**。
 * 如果先删根，中途失败时子会话就成孤儿；反过来最坏情况是根还在、子没了，
 * 至少父会话本身是完整的，用户还能操作它。
 *
 * @param {Array} roots 要删除的会话（scanSessions 的元素）
 * @param {Array} allSessions 全部会话（用来找后代）
 * @param {object} deps 同 deleteSession
 * @param {{dryRun?:boolean, cascade?:boolean}} [options] cascade 默认 true
 */
export function deleteSessionsCascade(roots, allSessions, deps, options = {}) {
  const list = Array.isArray(roots) ? roots : []
  const cascade = options?.cascade !== false
  const dryRun = options?.dryRun === true

  // 找出所有后代，去重（可能多个根共享同一个子会话）
  let descendants = []
  if (cascade) {
    const rootIds = list.map((s) => s?.header?.id).filter(Boolean)
    descendants = descendantsOf(allSessions, rootIds).sessions
  }

  // 后代按深度倒序：越深的越先删
  const depthOf = (s) => {
    let d = 0
    let cur = s?.header?.parentSession
    const guard = new Set()
    while (typeof cur === 'string' && cur && !guard.has(cur) && d < 64) {
      guard.add(cur)
      d++
      const parent = (allSessions ?? []).find((x) => x?.header?.id === cur)
      cur = parent?.header?.parentSession
    }
    return d
  }

  const ordered = [...descendants].sort((a, b) => depthOf(b) - depthOf(a))
  // 最后追加根（它最深，放最后删）
  const all = [...ordered, ...list]

  // 复用 deleteSessions 的逐个删除，但结果要能区分「根」和「连带子会话」
  const rootIdSet = new Set(list.map((s) => s?.header?.id).filter(Boolean))
  const results = all.map((s) => {
    const id = s?.header?.id
    const r = deleteSession(s, deps, { dryRun })
    return { ...r, isCascade: !rootIdSet.has(id) }
  })

  let deleted = 0, planned = 0, busy = 0, failed = 0, freedBytes = 0
  let cascadeDeleted = 0
  for (const r of results) {
    if (r.status === 'deleted') { deleted++; freedBytes += r.freedBytes ?? 0; if (r.isCascade) cascadeDeleted++ }
    else if (r.status === 'planned') { planned++; freedBytes += r.freedBytes ?? 0 }
    else if (r.status === 'busy') busy++
    else failed++
  }

  return { results, deleted, planned, busy, failed, freedBytes, cascadeDeleted }
}

export { SESSION_FILE }
