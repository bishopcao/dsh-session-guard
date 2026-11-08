// dsh-session-guard — 核心逻辑（纯函数 + 文件操作，不依赖 DSH 上下文）
//
// 设计要点
// --------
// DSH 把会话存成 zstd 多帧拼接文件 session.v4.jsonl.zstd：
//   第 0 帧 = session header（JSON），其中 parentSession 字段就是父子关系的唯一来源。
//   后续帧 = 事件流，追加写入。
//
// 归档插件删除会话时（cascade.ts:69-81）会把"选中项 + 它的全部后代"一起物理删除，
// 且 rmSync 直删、不进回收站。这就是"删父带走子"的根因。
//
// 因为没有官方 hook 能拦截删除，本模块的策略是：
//   让父子关系根本不产生 —— 主动把真实对话的 parentSession 清空。
//
// ── 与 DSH 实现对齐的三条硬约束（2026-11-02 逐条核对源码后修正）──────────
//
// 1) 帧边界必须按**完整帧头解析**，不能用「找第二个魔数」。
//    DSH 的 scanZstdFrames（persistence-jsonl lib/index.js L1300）是自己走帧结构：
//    读 4 字节魔数 → 1 字节 FHD → 按 FHD 算剩余头长度 → 逐 block 跳到 lastBlock
//    → 有 checksum 再跳 4 字节。用魔数扫描有一天会被压缩流内部的字节序列骗到。
//
// 2) 重压帧必须带 checksum，与 DSH 的写入参数一致。
//    DSH：const CHECKSUM_OPTIONS = { params: { [ZSTD_c_checksumFlag]: 1 } }
//    并注释「Compress one independently decodable, checksummed Zstandard frame」。
//    我们用同一份参数，保证第 0 帧与其余帧同格式。
//
// 3) DSH 用 open(path, 'a') 追加写入，**读完到写入之间可能有新事件落盘**。
//    所以写入后必须重新读一次磁盘，确认「事件部分」与我们读到的完全一致；
//    不一致说明期间有追加，此时**放弃本次写入**（不能覆盖掉别人的新数据）。
//
// 只处理 origin !== 'subagent' 的会话：
//   origin='subagent' 是工具/子代理产生的中间会话，它们的父子关系是正常运行时结构。
import {
  readFileSync, writeFileSync, readdirSync, statSync, existsSync,
  mkdirSync, copyFileSync, openSync, closeSync, truncateSync,
  readSync, fstatSync,
} from 'node:fs'
import { zstdDecompressSync, zstdCompressSync, constants } from 'node:zlib'
import { join } from 'node:path'

const ZSTD_MAGIC_LE = 4247762216 // 0x28 0xB5 0x2F 0xFD 的小端 uint32

/** 与 DSH 写入侧完全一致：强制带 checksum 的独立可解帧。 */
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/**
 * 按 DSH 的 scanZstdFrames 逻辑，逐个扫描完整的 zstd 帧边界。
 *
 * 与 DSH 的唯一区别：DSH 遇到尾部残帧返回 tornStart，我们直接丢弃残帧
 * （只关心完整的第 0 帧）。
 *
 * @param {Buffer} buffer
 * @param {number} [maxFrames] 最多返回多少帧
 * @returns {{frames: {start:number,end:number}[], tornStart?: number}}
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC_LE) {
      // 魔数不对：如果是第一个帧，说明文件格式不认识；返回已扫到的
      return { frames, tornStart: start }
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }

    const descriptor = buffer.readUInt8(offset)
    offset += 1
    // bit3/bit4 是保留位，DSH 视为损坏
    if ((descriptor & 24) !== 0) return { frames, tornStart: start }

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes

    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) return { frames, tornStart: start } // 保留类型 = 损坏
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }

    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/**
 * 第 0 帧的字节长度（= 第一个完整帧的 end）。扫不到完整帧时返回 -1。
 * 保留旧接口名，内部改成完整帧解析。
 */
export function frame0Length(buf) {
  const { frames } = scanZstdFrames(buf, 1)
  return frames.length > 0 ? frames[0].end : -1
}

/** 读一个会话文件的 header（只解压第 0 帧）。返回 null 表示无法解析。 */
/**
 * 读会话文件的 header（第 0 帧）。
 *
 * 性能：早先这里用 readFileSync 整个文件读进内存，实测 258 个会话
 * 总共 488 MB（中位数 186 KB，最大 40 MB），一次扫描要 484 ms。
 * 但第 0 帧只有几百字节，读完它就知道 id/parentSession，根本不需要
 * 文件的其余部分。所以改成按需分块读：
 *
 *   1. 先读 64 KB —— 绝大多数会话的第一帧都在这个范围内；
 *   2. 解不出来再翻倍到 256 KB、1 MB、4 MB（极少走到这步）；
 *   3. 都不行才退回整文件读（保证老行为兜底，不丢数据）。
 *
 * 为什么不用 fd + readSync：zstd 解压需要一个完整的 Buffer 切片，
 * 分块读进来拼起来反而多一次拷贝；直接 openSync + readSync 到
 * 目标 Buffer 只读一遍，最少 IO。
 */
export function readHeader(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    if (size <= 0) return null

    // 阶梯式尝试：读到够解出第一帧为止
    for (const want of [65536, 262144, 1048576, 4194304]) {
      const n = Math.min(size, want)
      if (n <= 0) continue
      const buf = Buffer.allocUnsafe(n)
      const got = readSync(fd, buf, 0, n, 0)
      const slice = got === n ? buf : buf.subarray(0, got)
      const header = readHeaderFromBuffer(slice)
      if (header) return header
      // 如果整个文件都读进来了还解不出，就没必要再试
      if (n >= size) return null
    }

    // 兜底：极端情况整文件读（例如第一帧异常大）
    try { return readHeaderFromBuffer(readFileSync(file)) } catch { return null }
  } catch {
    return null
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* ignore */ } }
  }
}

/** 从 buffer 读 header（供已有 buffer 的场景复用，避免重复读盘）。 */
export function readHeaderFromBuffer(buf) {
  try {
    const len = frame0Length(buf)
    if (len <= 0) return null
    return JSON.parse(zstdDecompressSync(buf.subarray(0, len)).toString('utf8'))
  } catch { return null }
}

/** 能否独占打开（false = 有进程正持有写句柄）。 */
function isFree(file) {
  try { const fd = openSync(file, 'r+'); closeSync(fd); return true }
  catch { return false }
}

/**
 * 扫描全部会话。
 * @returns {{proj:string, seg:string, dir:string, file:string, header:object, size:number}[]}
 */
export function scanSessions(sessionsRoot) {
  const out = []
  if (!existsSync(sessionsRoot)) return out
  let projects
  try { projects = readdirSync(sessionsRoot) } catch { return out }
  for (const proj of projects) {
    const pdir = join(sessionsRoot, proj)
    let entries
    try { entries = readdirSync(pdir) } catch { continue }
    for (const seg of entries) {
      const dir = join(pdir, seg)
      let st
      try { st = statSync(dir) } catch { continue }
      if (!st.isDirectory()) continue
      const file = join(dir, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      const header = readHeader(file)
      if (!header) continue
      let size = 0
      try { size = statSync(file).size } catch { /* ignore */ }
      out.push({ proj, seg, dir, file, header, size })
    }
  }
  return out
}

/**
 * 按会话 id 直接定位会话，不扫全部文件。
 *
 * 为什么需要它：`scanSessions()` 要对每个会话文件 readHeader（打开 + 读帧头 +
 * 解压第一帧）。实测 199 个会话要 260 ms，而 `session/created` 事件每创建
 * 一个新会话/分支都会触发一次，且只为从结果里挑出刚创建的那一个。
 * 直接按目录结构定位只要 1~2 ms。
 *
 * 目录布局（实测 199/199 吻合，非 DSH 书面契约）：
 *   <sessionsRoot>/<项目编码>/<会话id>/session.v4.jsonl.zstd
 *
 * 安全设计：
 *   1. 只做字符串比较 + statSync，命中后才 readHeader（读 1 个文件而非 N 个）
 *   2. 目录名匹配之外，还要校验 header.id 真的等于目标 id
 *   3. 失败一律返回 null，由调用方回退到 scanSessions()（行为与旧代码一致）
 *   4. 所有异常在内部吃掉，不向 session/created 钩子抛出
 *
 * @param {string} sessionsRoot 会话根目录
 * @param {string} id 会话 id（形如 session-xxxxxxxx-...）
 * @returns {{proj:string, seg:string, dir:string, file:string, header:object, size:number}|null}
 */
export function findSessionById(sessionsRoot, id) {
  if (typeof sessionsRoot !== 'string' || typeof id !== 'string' || !id) return null
  if (!existsSync(sessionsRoot)) return null
  let projects
  try { projects = readdirSync(sessionsRoot) } catch { return null }
  for (const proj of projects) {
    const pdir = join(sessionsRoot, proj)
    let entries
    try { entries = readdirSync(pdir) } catch { continue }
    // 先在目录名里找，不命中就跳过整个项目（零读取开销）
    if (!entries.includes(id)) continue
    const dir = join(pdir, id)
    let st
    try { st = statSync(dir) } catch { continue }
    if (!st.isDirectory()) continue
    const file = join(dir, 'session.v4.jsonl.zstd')
    if (!existsSync(file)) continue
    const header = readHeader(file)
    if (!header) continue
    // 目录名对上了也要确认 header 真是这个会话
    if (header.id !== id) continue
    let size = 0
    try { size = statSync(file).size } catch { /* ignore */ }
    return { proj, seg: id, dir, file, header, size }
  }
  return null
}

/**
 * 按 id 找会话，找不到时回退到全量扫描。
 *
 * 回退保证「最坏情况与改动前完全一致」：即使 DSH 未来改了目录布局，
 * 也只是退回 260 ms 的慢路径，功能不受影响。
 *
 * @param {string} sessionsRoot 会话根目录
 * @param {string} id 会话 id
 * @returns {{proj:string, seg:string, dir:string, file:string, header:object, size:number}|null}
 */
export function findSessionByIdWithFallback(sessionsRoot, id) {
  const fast = findSessionById(sessionsRoot, id)
  if (fast !== null) return fast
  try {
    return scanSessions(sessionsRoot).find((s) => s.header.id === id) ?? null
  } catch {
    return null
  }
}

/** 从 projcache 取标题（取不到就返回 null）。 */
export function titleOf(projCacheDir, id) {
  try {
    const p = join(projCacheDir, `${id}.json`)
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return j?.record?.rows?.title?.val ?? null
  } catch { return null }
}

/**
 * 显示用的会话名称，带逐级降级。
 *
 * 为什么需要降级：相当一部分会话**天生没有标题**——
 *   · 空会话（创建后没说过话）DSH 不会生成标题，projcache 里 title.val 是 null
 *   · subagent 会话通常也没有标题
 * 这些在备份列表里如果直接显示 id 片段（session-767ef6a8），用户认不出是什么。
 *
 * 降级顺序：
 *   1. 正式标题
 *   2. 来源工作区目录名（Downloads / deepseekwork …）
 *   3. subagent 会话标成「子代理会话」
 *   4. 都没信息才用短 id
 *
 * @param {string} projCacheDir
 * @param {string} id
 * @param {{origin?:string, cwd?:string}} [hint] 可选：从会话 header 或备份记录带进来的线索
 * @returns {{name:string, kind:'title'|'cwd'|'subagent'|'id', title:string|null}}
 */
export function displayNameOf(projCacheDir, id, hint = {}) {
  // 0. 调用方直接给的标题（通常来自备份记录 index.json）
  //
  // 这一步很关键：会话被删掉后 projcache 会跟着消失，
  // 但备份记录里往往还留着当初记下的标题。
  // 不看它就只能退化成一串 id，用户根本判断不出哪个是误删的。
  const given = typeof hint?.title === 'string' ? hint.title.trim() : ''
  if (given) return { name: given, kind: 'title', title: given }

  // 1. projcache 里的实时标题
  const title = titleOf(projCacheDir, id)
  if (typeof title === 'string' && title.trim()) {
    return { name: title.trim(), kind: 'title', title: title.trim() }
  }

  // 2. 工作区目录名
  let cwd = typeof hint?.cwd === 'string' && hint.cwd ? hint.cwd : null
  if (!cwd) {
    try {
      const p = join(projCacheDir, `${id}.json`)
      if (existsSync(p)) {
        const j = JSON.parse(readFileSync(p, 'utf8'))
        const c = j?.record?.identity?.cwd
        if (typeof c === 'string' && c) cwd = c
      }
    } catch { /* ignore */ }
  }
  if (cwd) {
    // 取最后一段目录名，比如 C:\Users\x\Downloads → Downloads
    const seg = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop()
    if (seg) return { name: `（空会话）${seg}`, kind: 'cwd', title: null }
  }

  // 3. subagent
  if (hint?.origin === 'subagent') {
    return { name: '（子代理会话）', kind: 'subagent', title: null }
  }

  // 4. 兜底：短 id
  const short = typeof id === 'string' ? id.replace(/^session-/, '').slice(0, 8) : String(id ?? '')
  return { name: `（无标题）${short}`, kind: 'id', title: null }
}

/**
 * 把一个会话的 parentSession 清掉。
 *
 * 竞态防护：写完立即回读，比对「事件部分」字节是否与读取时一致。
 * DSH 用 open(path,'a') 追加事件，如果这期间有新事件落盘，我们的整文件写入
 * 会把它们覆盖掉。发现不一致就还原备份并报 conflict，下次再试。
 *
 * @param {object} session  scanSessions() 的元素
 * @param {object} [options]
 * @param {boolean} [options.dryRun]  只返回计划，不写盘
 * @param {boolean} [options.backup]  写盘前备份，默认 true
 * @returns {{id:string, status:'detached'|'already'|'busy'|'failed'|'conflict'|'planned',
 *            parentSession?:string, reason?:string, backup?:string,
 *            bytesBefore?:number, bytesAfter?:number}}
 */
export function detachSession(session, options = {}) {
  // 防御：调用方可能传 null/undefined 或结构不完整的对象
  if (!session || typeof session !== 'object' || !session.header || typeof session.file !== 'string') {
    return {
      id: session?.header?.id ?? '(unknown)',
      status: 'failed',
      reason: '入参不是有效的会话对象',
    }
  }
  const { dryRun = false, backup = true } = options ?? {}
  const h = session.header
  const id = h.id

  if (h.parentSession === undefined) {
    return { id, status: 'already' }
  }
  if (!isFree(session.file)) {
    return { id, status: 'busy', parentSession: h.parentSession, reason: '文件正被写入' }
  }

  let buf
  try { buf = readFileSync(session.file) } catch (e) {
    return { id, status: 'failed', reason: '读取失败: ' + String(e).slice(0, 120) }
  }

  const f0 = frame0Length(buf)
  if (f0 <= 0) {
    return { id, status: 'failed', reason: '第 0 帧不完整或格式不认识' }
  }

  // ── 快照一致性检查 ────────────────────────────────────────────────
  // session.header 来自 scanSessions() 那一刻的快照，而 buf 是刚读的。
  // 如果这期间 DSH 已经改过第 0 帧（比如把 parentSession 清掉了，或文件被换成别的会话），
  // 用旧 header 算出的新帧会写错数据。发现不一致就放弃，让调用方重扫。
  const currentHeader = readHeaderFromBuffer(buf)
  if (!currentHeader || currentHeader.id !== id) {
    return { id, status: 'conflict', parentSession: h.parentSession, reason: '磁盘上的会话已变化（id 不符）' }
  }
  if (currentHeader.parentSession === undefined) {
    // 已经被别人处理过了
    return { id, status: 'already' }
  }

  // 事件部分（第 0 帧之后的全部字节），用于写入前后的竞态比对
  const eventsPart = buf.subarray(f0)

  const obj = { ...currentHeader }
  delete obj.parentSession
  let newFrame
  try {
    newFrame = zstdCompressSync(Buffer.from(JSON.stringify(obj) + '\n', 'utf8'), CHECKSUM_OPTIONS)
  } catch (e) {
    return { id, status: 'failed', reason: '压缩失败: ' + String(e).slice(0, 120) }
  }

  const spliced = Buffer.concat([newFrame, eventsPart])

  if (dryRun) {
    return {
      id, status: 'planned', parentSession: currentHeader.parentSession,
      bytesBefore: buf.length, bytesAfter: spliced.length,
    }
  }

  // 备份
  let backupPath
  if (backup) {
    try {
      const bakDir = join(session.dir, 'backup')
      mkdirSync(bakDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      backupPath = join(bakDir, `session.v4.jsonl.zstd.bak-${stamp}`)
      copyFileSync(session.file, backupPath)
    } catch (e) {
      return { id, status: 'failed', reason: '备份失败: ' + String(e).slice(0, 120) }
    }
  }

  // 写入前再确认磁盘没变（缩小窗口到「备份完成 → 写入」之间）。
  // 比对整个文件字节：不仅事件区，连第 0 帧也一起比，任何改动都说明有并发写。
  try {
    const now = readFileSync(session.file)
    if (now.length !== buf.length || !now.equals(buf)) {
      return { id, status: 'conflict', parentSession: currentHeader.parentSession, reason: '读取后文件已被修改，本次放弃' }
    }
  } catch (e) {
    return { id, status: 'failed', reason: '写入前复查失败: ' + String(e).slice(0, 120) }
  }

  // 写入
  try { writeFileSync(session.file, spliced) }
  catch (e) { return { id, status: 'failed', parentSession: currentHeader.parentSession, reason: '写入失败: ' + String(e).slice(0, 120) } }

  // 校验
  let ok = true
  const why = []
  try {
    const chk = readFileSync(session.file)
    const frames = scanZstdFrames(chk).frames
    if (frames.length === 0) { ok = false; why.push('新的第 0 帧无法解析') }
    else {
      const nh = JSON.parse(zstdDecompressSync(chk.subarray(0, frames[0].end)).toString('utf8'))
      if ('parentSession' in nh) { ok = false; why.push('parentSession 未移除') }
      if (nh.id !== id) { ok = false; why.push('id 变化') }
      // 事件部分必须逐字节保持原样
      if (!chk.subarray(frames[0].end).equals(eventsPart)) {
        ok = false
        why.push('事件区被改动')
      }
    }
    // 整体可解压（与 DSH 的读取路径一致）
    const txt = zstdDecompressSync(chk).toString('utf8')
    const lines = txt.split('\n').filter(Boolean)
    const origLines = zstdDecompressSync(buf).toString('utf8').split('\n').filter(Boolean)
    if (lines.length !== origLines.length) { ok = false; why.push(`行数 ${origLines.length}->${lines.length}`) }
  } catch (e) { ok = false; why.push('回读失败: ' + String(e).slice(0, 100)) }

  if (!ok) {
    if (backupPath) { try { copyFileSync(backupPath, session.file) } catch { /* ignore */ } }
    return { id, status: 'failed', parentSession: currentHeader.parentSession, reason: '校验失败已回滚: ' + why.join('; '), backup: backupPath }
  }

  return {
    id, status: 'detached', parentSession: currentHeader.parentSession,
    backup: backupPath, bytesBefore: buf.length, bytesAfter: spliced.length,
  }
}

/**
 * 找出所有"真实对话 fork"（origin !== 'subagent' 且有 parentSession）。
 * 这就是删除时会被连带带走的对象。
 */
export function realDialogForks(sessions) {
  if (!Array.isArray(sessions)) return []
  return sessions.filter(s =>
    s?.header?.parentSession !== undefined && s.header.origin !== 'subagent'
  )
}

/** 找出悬空引用（父会话已经不存在了）。 */
export function danglingForks(sessions) {
  if (!Array.isArray(sessions)) return []
  const ids = new Set()
  for (const s of sessions) {
    const id = s?.header?.id
    if (typeof id === 'string' && id) ids.add(id)
  }
  return sessions.filter(s =>
    s?.header?.parentSession !== undefined && !ids.has(s.header.parentSession)
  )
}

/** 按父会话分组，返回亲子树（只含真实对话）。 */
export function lineageTree(sessions) {
  if (!Array.isArray(sessions)) return { roots: [], childrenOf: new Map(), knownIds: new Set() }
  const ids = new Set()
  for (const s of sessions) {
    const id = s?.header?.id
    if (typeof id === 'string' && id) ids.add(id)
  }
  const childrenOf = new Map()
  for (const s of sessions) {
    const p = s?.header?.parentSession
    if (typeof p !== 'string' || !p) continue
    if (s.header.origin === 'subagent') continue
    if (!childrenOf.has(p)) childrenOf.set(p, [])
    childrenOf.get(p).push(s)
  }
  const hasParent = new Set([...childrenOf.values()].flat().map(s => s.header.id))
  const roots = sessions.filter(s =>
    s?.header && s.header.origin !== 'subagent' && !hasParent.has(s.header.id)
  )
  return { roots, childrenOf, knownIds: ids }
}

/**
 * 数据体检：把 scanSessions() 静默跳过的会话逐个找出来。
 *
 * 为什么需要：scanSessions 里有一串 `continue`，任何一步失败（目录读不了、
 * 文件不存在、header 解不出来）都会悄悄跳过那个会话。
 * 用户看不到任何提示，只会在「备份列表少了一个」时疑惑。
 *
 * 这个函数反过来做：走同一套目录结构，但**记录每个会话为什么被跳过**。
 * 只读，不改任何东西。
 *
 * @param {string} sessionsRoot 会话根目录
 * @returns {{
 *   scanned:number,          成功读到的会话数
 *   skipped:number,          被跳过的数量
 *   problems:Array<{proj:string, seg:string, dir:string, reason:string, detail?:string}>,
 *   byReason:Record<string, number>,
 *   ok:boolean               没有任何问题
 * }}
 */
export function auditSessions(sessionsRoot) {
  const problems = []
  const byReason = Object.create(null)
  let scanned = 0

  const add = (proj, seg, dir, reason, detail) => {
    problems.push({ proj, seg, dir, reason, detail })
    byReason[reason] = (byReason[reason] ?? 0) + 1
  }

  if (!existsSync(sessionsRoot)) {
    return { scanned: 0, skipped: 0, problems, byReason, ok: true }
  }

  let projects
  try {
    projects = readdirSync(sessionsRoot)
  } catch (e) {
    return {
      scanned: 0, skipped: 0, problems,
      byReason, ok: false,
      rootError: String(e?.message ?? e),
    }
  }

  for (const proj of projects) {
    const pdir = join(sessionsRoot, proj)
    let entries
    try {
      entries = readdirSync(pdir)
    } catch (e) {
      add(proj, '', pdir, 'project-unreadable', String(e?.message ?? e))
      continue
    }

    for (const seg of entries) {
      const dir = join(pdir, seg)
      let st
      try {
        st = statSync(dir)
      } catch (e) {
        // 竞态：列目录和 stat 之间被删掉了，不算问题
        const msg = String(e?.message ?? e)
        if (/ENOENT/.test(msg)) continue
        add(proj, seg, dir, 'stat-failed', msg)
        continue
      }
      if (!st.isDirectory()) continue

      const file = join(dir, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) {
        // 目录存在但没有会话文件 —— 可能是别的东西误建，也可能是删了一半
        let kids = []
        try { kids = readdirSync(dir) } catch { /* ignore */ }
        if (kids.length > 0) add(proj, seg, dir, 'no-session-file', kids.slice(0, 5).join(', '))
        else add(proj, seg, dir, 'empty-dir')
        continue
      }

      // 文件存在，试读 header
      const header = readHeader(file)
      if (!header) {
        let size = 0
        try { size = statSync(file).size } catch { /* ignore */ }
        add(proj, seg, dir, 'header-unreadable', size === 0 ? '文件 0 字节' : `文件 ${size} 字节但解不出帧头`)
        continue
      }
      if (typeof header.id !== 'string' || !header.id) {
        add(proj, seg, dir, 'no-id', `header 缺 id 字段，实际键: ${Object.keys(header).slice(0, 6).join(',')}`)
        continue
      }
      // 目录名和 header.id 不一致：不影响使用，但值得一提
      if (header.id !== seg) {
        add(proj, seg, dir, 'id-mismatch', `目录名 ${seg} ≠ header.id ${header.id}`)
        // 仍然算扫描成功（能读）
      }
      scanned++
    }
  }

  const skipped = problems.length
  return { scanned, skipped, problems, byReason, ok: skipped === 0 }
}
