// dsh-session-guard — 插件主体
//
// 目的
// ----
// DSH 归档插件删除会话时（@linxin666/dsh-session-archive 的 cascade.ts:69-81）
// 会把「选中会话 + 它的全部后代」一起物理删除，且 rmSync 直删不进回收站。
// 2026-11-01 已因此真实丢过对话。
//
// DSH 内核对"删除会话"没有提供 hook，无法从外部拦截。所以本插件换一条路：
// 主动清除真实对话的 parentSession，让父子关系根本不产生——
// 父话题被删时，子话题在数据结构上已经不是它的后代，自然不会被带走。
//
// 三道防线
// --------
//   1. session/created 事件 —— 新分支一创建就断开（最根本的时机）
//   2. 启动全量扫描      —— 清历史遗留
//   3. 手动工具          —— 随时查看 / 补处理
//
// 提供两个工具
// ------------
//   dsh_session_lineage  —— 查看当前父子链 / 风险点
//   dsh_detach_sessions  —— 解除父子关系（默认 dryRun，必须显式 confirm 才落盘）
//
// 另外向 Web UI 提供一个配置块（plugins.bundle.config），
// 显示自动独立的开关与最近解除记录。
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  existsSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, readdirSync, appendFileSync,
} from 'node:fs'
import {
  scanSessions,
  findSessionByIdWithFallback,
  realDialogForks,
  danglingForks,
  lineageTree,
  titleOf,
  displayNameOf,
  detachSession,
  auditSessions,
} from './core.js'
import {
  appendRecords,
  pruneRecords,
  clearRecords,
  readRecords,
} from './records.js'
import {
  backupSessions,
  backupStats,
  listRestorable,
  restoreSession,
  dropBackup,
  listBackups,
  dropBackups,
  pruneBackups,
  backupRoot,
  readIndex,
} from './backup.js'
import { deleteSessionsCascade, descendantsOf } from './delete.js'

export const name = 'dsh-session-guard'

// tools  : 注册两个工具
// webServer: 给 Web UI 提供 /session-guard 接口
//
// 注意 workspaceRegistry **不写在这里**：它是可选依赖，
// 声明进 inject 会让插件在缺少它的宿主上直接起不来。
// 改成 apply 里 try 抓引用，拿不到就退化为「只删文件」。
export const inject = ['tools', 'webServer']

/**
 * DSH 的 Workspace 注册表（可选）。拿到它就能把会话从列表状态里摘掉。
 *
 * 为什么需要：DSH 的侧边栏列表读的是 Host 内存里的会话快照，不是磁盘。
 * 本插件直接 rmSync 会让「磁盘已删、Host 仍认为活着」——界面上删不掉，
 * 而且给那个会话发消息会 ENOENT（Host 去开一个不存在的文件）。
 *
 * workspaceRegistry.archiveSession(id) 是 DSH 自己的归档通道：
 * 把 id 写进 archivedSessionIds 并持久化，列表立刻过滤掉它。
 * 这就是「真删除 + 从列表消失」的正解。
 */
let workspaceRegistry = null

/** DSH_HOME（默认 ~/.dsh），与其他插件的约定一致。 */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}
function sessionsRoot() {
  return join(dshHome(), 'sessions')
}
function projCacheDir() {
  return join(dshHome(), 'storages', 'session_projcache', 'sessions')
}

/**
 * 快速取出「磁盘上还存在的会话 id」。
 *
 * 为什么不直接用 scanSessions：
 * 那个要逐个打开 session.v4.jsonl.zstd 读帧头，226 个约 230ms。
 * 这里只需要判断存活，列两级目录就够，实测 2ms，两者 id 集合完全一致。
 *
 * 注意：只用于「判断存在与否」，需要 header 内容（origin/cwd/标题）时
 * 仍然要用 findSessionByIdWithFallback 单独查。
 */
function liveSessionIds() {
  const ids = new Set()
  try {
    const root = sessionsRoot()
    for (const proj of readdirSync(root, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue
      const dir = join(root, proj.name)
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (d.isDirectory()) ids.add(d.name)
      }
    }
  } catch { /* ignore */ }
  return ids
}

/** 带标题的会话描述，给模型和用户看。 */
function describe(session, pc) {
  const title = titleOf(pc, session.header.id) ?? '(无标题)'
  const parent = session.header.parentSession
  return { id: session.header.id, title, parentSession: parent ?? null }
}

export function apply(ctx, config = {}) {
  // 整个 apply 包一层：任何一步抛异常都记进 DSH 日志。
  //
  // 为什么需要：Cordis 会吞掉插件 apply 里的异常，插件就"静默消失"——
  // 卡片还在（client 侧加载成功）、但工具和路由全都没了，现象是
  // UI 一直报 HTTP 404，而日志里什么线索都没有。
  // 2026-11-09 就因为 render 放错层级触发过一次，排查了很久。
  try {
    applyInner(ctx, config)
  } catch (error) {
    const message = String(error?.message ?? error)
    ctx.logger?.error?.(`[dsh-session-guard] apply 失败: ${message}`)
    throw error
  }
}

function applyInner(ctx, config = {}) {
  const pc = projCacheDir()

  // ---------- 抓取 Workspace 注册表（可选依赖）----------
  //
  // archiveSession 走 DSH 自己的归档通道，让「删掉的会话」从侧边栏消失。
  // 拿不到就退化为只删文件，列表要重启才更新——功能仍在，只是体验差一点。
  try {
    workspaceRegistry = ctx.workspaceRegistry || null
  } catch { workspaceRegistry = null }
  try {
    ctx.logger?.info?.(
      workspaceRegistry
        ? '[dsh-session-guard] workspaceRegistry 已就绪，删除后会同步从列表移除'
        : '[dsh-session-guard] 未拿到 workspaceRegistry，删除后需重启 DSH 列表才更新',
    )
  } catch { /* ignore */ }

  /** 把会话从 DSH 列表状态里摘掉（归档语义）。拿不到注册表就跳过。 */
  async function archiveFromList(id) {
    if (!workspaceRegistry) return   // 退化：只删文件
    // 不传 stopActivity：会话在跑就让 archiveSession 抛 WorkspaceActiveSessionError，
    // 我们把它翻译成「正在运行，先停止」。直接强停可能丢正在生成的内容。
    await workspaceRegistry.archiveSession(id)
  }

  // ---------- 工具 1：查看父子关系 ----------
  ctx.effect(() => ctx.tools.register({
    name: 'dsh_session_lineage',
    description:
      'Inspect DSH session parent/child lineage. Shows which conversations were forked from which, '
      + 'which are at risk of being cascade-deleted together with their parent, and any dangling '
      + 'parent references. Read-only.',
    // 必须写成**标准 JSON Schema**（type: 'object' + properties）。
    // 扁平写法（直接列属性）DSH 能接受，但它会把该对象原样发给上游；
    // 走 TRAE 之类的网关时，对方做标准校验会报
    //   tools.N.function.parameters must be a JSON Schema of type object
    // 所以这里显式包一层，与官方工具的输出保持一致。
    parameters: {
      type: 'object',
      properties: {
        includeSubagent: {
          type: 'boolean',
          description: 'Also list subagent-origin sessions (tool-generated, normally not shown in the topic list). Defaults to false.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      // 标准 JSON Schema：type 只能是 object/array/string/number/integer/boolean/null。
      // 早期写 { type: 'json' } 会被宿主拒绝（JsonSchemaError）。
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '人类可读的关系摘要' },
          counts: {
            type: 'object',
            description: '会话总数 / 真实对话 fork 数 / 悬空引用数',
            properties: {
              total: { type: 'integer' },
              forks: { type: 'integer' },
              dangling: { type: 'integer' },
            },
            required: ['total', 'forks', 'dangling'],
          },
        },
        required: ['text', 'counts'],
      },
      // render 必须和 schema 同级、放在 output 里面。
      // DSH 注册时会校验 `output { schema, render, presentationMeta? }`，
      // 缺 render 直接抛：tool "xxx" must declare output { schema, render, ... }
      // 返回值会被当成工具结果的 content 使用，宿主对它调用 .some(...)，
      // 所以必须返回**数组**（ContentBlock[]）；返回单个对象会在
      //   result.content.some((block) => block.type === 'image')
      // 处抛 `content.some is not a function`，整个工具调用直接失败。
      render: (args, value) => [{ type: 'text', text: value.text }],
    },
    execute: () => {
      const all = getSessions()
      const forks = realDialogForks(all)
      const dangling = danglingForks(all)
      const tree = lineageTree(all)

      const lines = []
      lines.push(`会话总数: ${all.length}`)
      lines.push(`真实对话 fork（删除时会被连带带走）: ${forks.length}`)
      lines.push(`悬空引用（父已不存在）: ${dangling.length}`)
      lines.push('')

      if (forks.length === 0) {
        lines.push('当前没有真实对话 fork —— 删任何话题都不会连带删除别的对话。')
      } else {
        lines.push('以下对话挂在父话题下面，删父会一起被删：')
        for (const f of forks) {
          const d = describe(f, pc)
          lines.push(`  ${d.id}  「${d.title}」`)
          lines.push(`      父: ${d.parentSession}`)
        }
      }

      if (dangling.length > 0) {
        lines.push('')
        lines.push('悬空引用（建议清理）:')
        for (const f of dangling) {
          const d = describe(f, pc)
          lines.push(`  ${d.id}  「${d.title}」 → 父 ${d.parentSession} 已不存在`)
        }
      }

      lines.push('')
      lines.push(`根会话: ${tree.roots.length} 个；有子会话的父会话: ${tree.childrenOf.size} 个`)

      return { text: lines.join('\n'), counts: { total: all.length, forks: forks.length, dangling: dangling.length } }
    },
  }), 'dsh-session-guard: lineage tool')

  // ---------- 工具 2：解除父子关系 ----------
  ctx.effect(() => ctx.tools.register({
    name: 'dsh_detach_sessions',
    description:
      'Detach DSH conversations from their parent so deleting the parent can no longer cascade-delete them. '
      + 'Works on the session header (parentSession field) inside each session file. '
      + 'Defaults to a dry run that only reports what would change; pass confirm=true to actually write. '
      + 'Each changed file is backed up under its session directory before writing, and verified afterwards.',
    // 同工具 1：必须用标准 JSON Schema 包装，避免上游网关校验失败。
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Detach one session by id (a unique 8-char prefix is enough). Omit to process every real-dialog fork.',
        },
        all: {
          type: 'boolean',
          description: 'Process every real-dialog fork. Defaults to true when sessionId is omitted.',
        },
        confirm: {
          type: 'boolean',
          description: 'Actually write the change. When false/omitted this is a dry run.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      // 标准 JSON Schema：type 只能是 object/array/string/number/integer/boolean/null。
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '人类可读的执行摘要' },
          dryRun: { type: 'boolean', description: '是否为预演（未写入）' },
          counts: {
            type: 'object',
            description: '已解除 / 待解除 / 跳过 / 失败 的数量',
            properties: {
              done: { type: 'integer' },
              planned: { type: 'integer' },
              busy: { type: 'integer' },
              failed: { type: 'integer' },
            },
            required: ['done', 'planned', 'busy', 'failed'],
          },
        },
        required: ['text', 'dryRun', 'counts'],
      },
      // 同工具 1：render 在 output 内部、和 schema 同级。
      render: (args, value) => [{ type: 'text', text: value.text }],
    },
    execute: (args = {}) => {
      const all = getSessions()
      const confirm = args.confirm === true
      const dryRun = !confirm

      // 提前返回也必须满足 output.schema 的 required —— 宿主会按 schema 校验结果，
      // 少字段直接判失败。这里统一补 dryRun / counts:0。
      const early = (reason) => ({
        text: reason,
        dryRun,
        counts: { done: 0, planned: 0, busy: 0, failed: 0 },
      })

      // 选中目标
      let targets = []
      if (typeof args.sessionId === 'string' && args.sessionId.trim()) {
        const key = args.sessionId.trim()
        const exact = all.filter(s => s.header.id === key || s.header.id === `session-${key}`)
        const partial = exact.length > 0 ? exact : all.filter(s => s.header.id.includes(key))
        if (partial.length === 0) {
          return early(`找不到会话 "${key}"。先用 dsh_session_lineage 看有哪些会话。`)
        }
        if (partial.length > 1) {
          const list = partial.map(s => `  ${s.header.id}  「${titleOf(pc, s.header.id) ?? '无标题'}」`).join('\n')
          return early(`"${key}" 匹配到多个会话，请给更长的 id 前缀：\n${list}`)
        }
        targets = partial
      } else {
        targets = realDialogForks(all)
      }

      if (targets.length === 0) {
        return early('没有需要解除的会话 —— 所有真实对话都已经是独立根会话。')
      }

      const results = targets.map(s => ({ ...detachSession(s, { dryRun }), title: titleOf(pc, s.header.id) ?? '(无标题)' }))

      const lines = []
      lines.push(dryRun ? '【预演】以下改动尚未写入' : '【已执行】')
      lines.push('')
      for (const r of results) {
        switch (r.status) {
          case 'detached':
            lines.push(`  已解除  ${r.id}  「${r.title}」`)
            lines.push(`          原父: ${r.parentSession}`)
            if (r.backup) lines.push(`          备份: ${r.backup}`)
            break
          case 'planned':
            lines.push(`  将解除  ${r.id}  「${r.title}」`)
            lines.push(`          原父: ${r.parentSession}   文件 ${r.bytesBefore} → ${r.bytesAfter} 字节`)
            break
          case 'already':
            lines.push(`  已独立  ${r.id}  「${r.title}」`)
            break
          case 'busy':
            lines.push(`  跳过    ${r.id}  「${r.title}」 — ${r.reason}`)
            break
          default:
            lines.push(`  失败    ${r.id}  「${r.title}」 — ${r.reason}`)
        }
      }

      const done = results.filter(r => r.status === 'detached').length
      const planned = results.filter(r => r.status === 'planned').length
      const busy = results.filter(r => r.status === 'busy').length
      const failed = results.filter(r => r.status === 'failed').length

      lines.push('')
      if (dryRun) {
        lines.push(`预演结果: ${planned} 个待解除，${busy} 个跳过，${failed} 个失败。`)
        lines.push('确认无误后，用 confirm=true 再调用一次即可真正写入。')
      } else {
        lines.push(`执行结果: ${done} 个已解除，${busy} 个跳过，${failed} 个失败。`)
      }

      return {
        text: lines.join('\n'),
        dryRun,
        counts: { done, planned, busy, failed },
      }
    },
  }), 'dsh-session-guard: detach tool')

  // ---------- 自动解除：两道防线 ----------
  // 设计目标是「父子关系一产生就断」，而不是等出事再补救。
  //
  // 防线 1（主）：监听 session/created —— 新会话或 fork 分支一创建就立刻断开。
  //               这是最根本的时机：分支出现的同时就分离，父子关系没有存在窗口。
  // 防线 2（兜）：启动时全量扫描 —— 清掉插件装好之前就存在的历史 fork。
  //
  // 只处理 origin !== 'subagent' 的会话；工具产生的子会话结构保持原样。
  // 单个文件失败不影响其他文件：core 层已做到「写前备份 → 写后校验 → 失败回滚」。
  //
  // autoEnabled 是**运行时**开关：
  //   - 初值来自 cordis.patch.yml 的 autoDetachOnMount
  //   - UI 上的开关改的是这个变量，立即生效、不需重启
  //   - 重启后回到配置文件的值（刻意不写回 YAML，避免插件改自己的配置源）
  const autoDetach = config?.autoDetachOnMount !== false
  let autoEnabled = autoDetach

  // 启动时是否做一次增量备份（cordis.patch.yml 的 backupOnMount，默认开）。
  // 关掉它就没有误删恢复了，所以默认开启。
  const backupOnMount = config?.backupOnMount !== false

  // 备份保留天数：cordis.patch.yml 的 backupRetentionDays 是**初始值**，
  // UI 上改过之后以用户的选择为准，并持久化到 ~/.dsh/session-guard-settings.json。
  //
  // 为什么需要持久化：之前只存在内存里，刷新页面或重启就回到配置文件的值，
  // 而且 loadBackups() 会拿后端返回的值覆盖本地选择，导致「选 7 天又跳回 30 天」。
  //
  // 只清理「会话已经不存在」的旧备份，还活着的会话不会因为过期被删——
  // 否则等于把正在用的会话从保护范围里踢出去。
  const DEFAULT_RETENTION_DAYS = (() => {
    const v = Number(config?.backupRetentionDays)
    return Number.isFinite(v) && v >= 0 ? v : 30
  })()

  /** 设置文件路径。 */
  const settingsFile = () => join(dshHome(), 'session-guard-settings.json')

  /** 读持久化的设置；坏了就回退到默认值。 */
  const readSettings = () => {
    try {
      const p = settingsFile()
      if (!existsSync(p)) return { retentionDays: DEFAULT_RETENTION_DAYS }
      const j = JSON.parse(readFileSync(p, 'utf8'))
      const v = Number(j?.retentionDays)
      return { retentionDays: Number.isFinite(v) && v >= 0 ? v : DEFAULT_RETENTION_DAYS }
    } catch {
      return { retentionDays: DEFAULT_RETENTION_DAYS }
    }
  }

  /** 原子写设置（临时文件 + 覆盖），无 BOM。 */
  const writeSettings = (s) => {
    try {
      const target = settingsFile()
      const tmp = `${target}.tmp`
      writeFileSync(tmp, JSON.stringify(s, null, 2), { encoding: 'utf8' })
      try { rmSync(target, { force: true }) } catch { /* ignore */ }
      renameSync(tmp, target)
      return true
    } catch {
      return false
    }
  }

  let backupRetentionDays = readSettings().retentionDays

  /** 对一批会话执行解除，把结果写进日志和记录。返回真实解除的数量。 */
  const detachAll = (sessions, reason, source = 'auto') => {
    const toRecord = []
    const results = sessions.map((s) => {
      const title = titleOf(pc, s.header.id) ?? '(无标题)'
      const parentId = s.header.parentSession
      const parentTitle = parentId ? (titleOf(pc, parentId) ?? null) : null
      const r = detachSession(s, { dryRun: false })

      // 成功解除的收集起来，最后一次性写入（一次读、一次写）
      if (r.status === 'detached') {
        toRecord.push({
          id: s.header.id,
          title,
          parentSession: parentId ?? null,
          parentTitle,
          at: Date.now(),
          source,
        })
      }
      return { ...r, title }
    })

    if (toRecord.length > 0) {
      const { ok } = appendRecords(dshHome(), toRecord)
      if (!ok) {
        ctx.logger?.warn?.(
          `[dsh-session-guard] ${toRecord.length} 条解除记录写入失败（会话本身已解除，仅记录丢失）。`,
        )
      }
    }

    const done = results.filter((r) => r.status === 'detached')
    const busy = results.filter((r) => r.status === 'busy')
    const conflict = results.filter((r) => r.status === 'conflict')
    const failed = results.filter((r) => r.status === 'failed')

    if (done.length > 0) {
      const detail = done
        .map((r) => `  ${r.id}  「${r.title}」 ← 原父 ${r.parentSession}`)
        .join('\n')
      ctx.logger?.info?.(
        `[dsh-session-guard] ${reason}：已解除 ${done.length} 个父子关系，` +
        `删除父话题不会再带走它们：\n${detail}`,
      )
    }
    if (busy.length > 0) {
      ctx.logger?.warn?.(
        `[dsh-session-guard] ${busy.length} 个会话正被写入，本次跳过（下次启动会重试）。`,
      )
    }
    if (conflict.length > 0) {
      ctx.logger?.warn?.(
        `[dsh-session-guard] ${conflict.length} 个会话在读取后被追加了新事件，本次放弃（避免覆盖数据，下次会重试）。`,
      )
    }
    if (failed.length > 0) {
      const detail = failed.map((r) => `  ${r.id}  ${r.reason}`).join('\n')
      ctx.logger?.warn?.(`[dsh-session-guard] ${failed.length} 个解除失败：\n${detail}`)
    }
    return done.length
  }

  // ---- 防线 1：新会话 / fork 分支创建即断开 ----
  // 事件监听**始终注册**，是否真正执行由 autoEnabled 决定。
  // 这样用户在 UI 里把开关打开后，无需重启就能生效。
  ctx.effect(() => {
    const dispose = ctx.on?.('session/created', (session) => {
      if (!autoEnabled) return
      try {
        const header = session?.header
        // 没有 parentSession 就是普通新建会话，不需要处理
        if (!header || header.parentSession === undefined) return
        // subagent 子会话不动
        if (header.origin === 'subagent') return

        const id = header.id ?? session.id
        // 已知 id 只找这一个会话：不扫全部文件。
        // 旧写法 scanSessions().find() 每次要读 199 个文件的帧头（实测 260ms），
        // 而 create 事件每新建一个会话/分支就触发一次；按目录定位只要 1~2ms。
        // 找不到时回退全量扫描，行为与改动前一致（文件未落盘等情况照旧走原逻辑）。
        const target = findSessionByIdWithFallback(sessionsRoot(), id)
        if (!target) {
          // 文件还没落盘：提醒一下，下次启动扫描会补处理
          ctx.logger?.info?.(
            `[dsh-session-guard] 检测到新分支 ${id}（父 ${header.parentSession}），文件尚未落盘，稍后启动扫描会补处理。`,
          )
          return
        }
        detachAll([target], `新分支创建即断开（${session.id}）`)
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-session-guard] 处理新会话失败: ${String(error)}`)
      }
    })
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }, 'dsh-session-guard: detach on create')

  // ---- 浅防线：会话一变就补备份（防「聊完就删，备份还是旧的」）----
  //
  // 之前只有两个备份时机：启动一次 + 手动点按钮。
  // 于是出现了这个空档：启动后聊了半小时，内容全在增量里没备份；
  // 这时候误删，恢复出来的是半小时前的版本。
  //
  // 这里监听 DSH 的会话变更事件，把「变了的那个会话」单独备份。
  // 关键考量：
  //   · 单个会话备份，不做全量扫描（全量 260ms，会被事件频率拖死）
  //   · 节流：同一会话 5 秒内最多备份一次，避免边打字边写盘
  //   · 失败只记日志，绝不向上抛——备份不能影响正常对话
  if (backupOnMount) {
    const BACKUP_THROTTLE_MS = 5000
    const lastBackupAt = new Map()   // id -> 上次备份时间

    const backupOne = (sessionOrId, reason) => {
      try {
        const id = typeof sessionOrId === 'string'
          ? sessionOrId
          : (sessionOrId?.header?.id ?? sessionOrId?.id)
        if (typeof id !== 'string' || !id) return

        const now = Date.now()
        const prev = lastBackupAt.get(id) ?? 0
        if (now - prev < BACKUP_THROTTLE_MS) return

        const target = findSessionByIdWithFallback(sessionsRoot(), id)
        if (!target) return

        const r = backupSessions(dshHome(), [target], { titleOf: (x) => titleOf(pc, x) })
        if (r.copied > 0 || r.failed > 0) {
          lastBackupAt.set(id, now)
        }
        if (r.copied > 0) {
          ctx.logger?.info?.(`[dsh-session-guard] 实时备份 ${id}（${reason}）`)
        }
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-session-guard] 实时备份失败: ${String(error)}`)
      }
    }

    // DSH 的会话事件名不固定（不同版本可能是 session/updated、session/appended 等），
    // 用可选链逐个挂，挂不上的静默跳过——有任何一个生效就够用。
    // 注意**不含** session/created：那个事件已经由上面的断开逻辑处理，
    // 新建的会话本身还没有内容，先让它落盘再由变更事件备份更合理。
    const EVENT_NAMES = [
      'session/updated',
      'session/appended',
      'session/turn-completed',
      'session/message',
      'session/changed',
    ]
    const disposers = []
    for (const name of EVENT_NAMES) {
      try {
        const d = ctx.on?.(name, (payload) => backupOne(payload, name))
        if (typeof d === 'function') disposers.push(d)
      } catch { /* 该事件不存在，跳过 */ }
    }

    ctx.effect(() => () => {
      for (const d of disposers) {
        try { d() } catch { /* ignore */ }
      }
    }, 'dsh-session-guard: live backup teardown')
  }

  // ---- 防线 2：启动全量扫描（清历史遗留） ----
  ctx.effect(() => {
    try {
      const all = getSessions()
      const forks = realDialogForks(all)
      const dangling = danglingForks(all)

      if (forks.length === 0) {
        if (autoDetach) {
          ctx.logger?.info?.('[dsh-session-guard] 启动扫描：没有需要解除的父子关系。')
        }
      } else if (autoDetach) {
        detachAll(forks, '启动扫描')
      } else {
        const list = forks
          .map((f) => `  ${f.header.id}  「${titleOf(pc, f.header.id) ?? '无标题'}」 父=${f.header.parentSession}`)
          .join('\n')
        ctx.logger?.warn?.(
          `[dsh-session-guard] 发现 ${forks.length} 个真实对话 fork（autoDetachOnMount 已关闭，仅提示）。\n${list}`,
        )
      }

      if (dangling.length > 0) {
        ctx.logger?.warn?.(`[dsh-session-guard] 发现 ${dangling.length} 个悬空 parentSession 引用。`)
      }

      // ---- 启动时做一次增量备份 ----
      // 归档插件删除会话用 rmSync 直删、不进回收站，所以真被删掉就再也找不回来。
      // 这里在启动时把仍在的会话留一份副本，之后即使被误删也能从 /restorable 恢复。
      // 增量：只复制大小或 mtime 变化的文件，正常情况下第二次启动几乎零拷贝。
      if (backupOnMount) {
        const r = backupSessions(dshHome(), all, { titleOf: (id) => titleOf(pc, id) })
        if (r.copied > 0) {
          ctx.logger?.info?.(
            `[dsh-session-guard] 备份：新增 ${r.copied} 个会话（${(r.bytes / 1048576).toFixed(1)} MB），跳过 ${r.skipped} 个未变化。`,
          )
        }
        if (r.failed > 0) {
          ctx.logger?.warn?.(`[dsh-session-guard] 备份：${r.failed} 个文件失败（不影响会话本身）。`)
        }

        // 按保留天数清理过期备份。
        // 只清「会话已经不在」的旧备份：还活着的会话如果因为过期被删，
        // 等于把它从保护范围里踢出去，那就本末倒置了。
        if (backupRetentionDays > 0) {
          const liveIds = new Set(all.map((s) => s.header.id))
          const p = pruneBackups(dshHome(), backupRetentionDays, { liveIds, onlyOrphans: true })
          if (p.removed > 0) {
            ctx.logger?.info?.(
              `[dsh-session-guard] 备份过期清理：移除 ${p.removed} 份（释放 ${(p.freedBytes / 1048576).toFixed(1)} MB），保留 ${p.kept} 份。`,
            )
          }
        }
      }
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-session-guard] 启动扫描失败: ${String(error)}`)
    }
    return () => {}
  }, 'dsh-session-guard: mount scan')

  // ---------- Web UI 数据接口 ----------
  // 浏览器侧的两个卡片从这里取数据、下命令。
  //
  //   GET  /session-guard/state          当前开关 + 存活记录 + 统计
  //   POST /session-guard/toggle         切换自动解除开关
  //   POST /session-guard/detach         解除指定会话（或全部）
  //   POST /session-guard/clear          清空记录
  //
  // autoEnabled 已在上面声明（运行时开关）。

  const ROUTE = '/session-guard'

  // 浏览器侧的诊断轨迹（最近 20 条，只在内存里）。
  // 用途：排查「删了但界面没反应」时，把决策链从浏览器搬到这里，
  // 免得只能盯着 F12 控制台猜。
  const diagLog = []

  // 结果缓存（问题：UI 每 5 秒轮询 2 个组件，每次都会扫 160+ 个会话文件）
  // 缓存 3 秒：足够让 UI 感觉实时，又把 IO 从 2 次/5秒 降到最多 1 次/3秒。
  const STATE_TTL_MS = 3000
  let stateCache = null
  let stateCacheAt = 0

  // ---------- 共享扫描缓存 ----------
  //
  // 为什么需要：UI 一挂载就并发发 4 个请求（两个组件各一个 /state、
  // 一个 /backups、一个 /restorable），每个都要 scanSessions() 一遍。
  // 实测 258 个会话扫一次 ~110 ms，4 个并发就是 4 次全量扫描，
  // 面板打开时那三四秒卡顿主要来自这里。
  //
  // 这里把「扫一次磁盘」的结果缓存起来，所有端点共用。
  // TTL 取 1200 ms：比 /state 的 3 秒短，保证写操作后能立刻看到新数据，
  // 又足够把同一批并发请求合并成一次扫描。
  const SCAN_TTL_MS = 1200
  let scanCache = null
  let scanCacheAt = 0

  /**
   * 拿到当前会话列表（带缓存）。同一时刻的并发调用只扫一次盘。
   * @param {boolean} invalidCache 写操作后强制重扫
   */
  const getSessions = (invalidCache = false) => {
    const now = Date.now()
    if (!invalidCache && scanCache && now - scanCacheAt < SCAN_TTL_MS) return scanCache
    const next = scanSessions(sessionsRoot())
    scanCache = next
    scanCacheAt = now
    return next
  }

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  const readBody = async (req) => {
    const chunks = []
    let total = 0
    for await (const chunk of req) {
      total += chunk.length
      // 防御：请求体不该超过 64 KiB
      if (total > 64 * 1024) throw new Error('request-too-large')
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (!text) return {}
    return JSON.parse(text)
  }

  /** 真正扫描并构造状态（较慢，走缓存）。 */
  const computeState = () => {
    const all = getSessions()
    const pruned = pruneRecords(dshHome(), all)
    const forks = realDialogForks(all)

    // 给记录补上「这个会话现在还有没有父关系」的实时状态
    const liveById = new Map(all.map((s) => [s.header.id, s]))
    const records = pruned.alive.map((r) => {
      const live = liveById.get(r.id)
      // 标题用现场读的覆盖存档里的。
      // 原因：解除发生在 session/created 那一刻，此时 DSH 还没生成标题
      // （标题由 session-title 异步产生），所以记录里存下来的是空。
      // 会话还活着就实时取，取不到才回退到记录里的旧值。
      const liveTitle = live ? titleOf(pc, r.id) : null
      return {
        ...r,
        title: liveTitle ?? r.title ?? '(无标题)',
        alive: live !== undefined,
        currentParent: live?.header.parentSession ?? null,
      }
    })

    return {
      ok: true,
      autoEnabled,
      stats: {
        totalSessions: all.length,
        pendingForks: forks.length,
        recordCount: records.length,
        prunedThisRead: pruned.removed,
      },
      // 孤儿子代理体检。
      //
      // 什么叫孤儿：origin==='subagent'，但它的 parentSession 已经不在磁盘上。
      // 为什么值得查：这类会话既不在任何父会话下（永远不会被级联删除），
      // 又因为 DSH 侧边栏隐藏 subagent 而看不见 —— 属于纯粹占空间的死数据。
      //
      // 正常情况下不该出现；一旦出现，通常意味着有人绕过本插件删过父会话
      // （比如用归档插件的级联删除，或者手动删目录）。
      orphanSubagents: (() => {
        try {
          const ids = new Set(all.map((s) => s.header.id))
          const out = []
          for (const s of all) {
            if (s?.header?.origin !== 'subagent') continue
            const p = s.header.parentSession
            // 没记父 id 的也算孤儿：无法归属，只能单独处理
            if (typeof p !== 'string' || !p) {
              out.push({
                id: s.header.id,
                title: titleOf(pc, s.header.id) ?? null,
                parentSession: null,
                size: s.size ?? 0,
                reason: 'no-parent-id',
              })
              continue
            }
            if (!ids.has(p)) {
              out.push({
                id: s.header.id,
                title: titleOf(pc, s.header.id) ?? null,
                parentSession: p,
                size: s.size ?? 0,
                reason: 'parent-gone',
              })
            }
          }
          return out
        } catch {
          return []
        }
      })(),
      records: records.slice(0, 100),
      pending: forks.map((f) => ({
        id: f.header.id,
        title: titleOf(pc, f.header.id) ?? '(无标题)',
        parentSession: f.header.parentSession,
      })),
      // 备份/恢复：这里只给数量与体积，明细走 GET /restorable
      backup: (() => {
        try {
          const s = backupStats(dshHome())
          return { count: s.count, bytes: s.bytes }
        } catch {
          return { count: 0, bytes: 0 }
        }
      })(),
    }
  }

  /** 带缓存的状态。invalidCache=true 时强制重算（写操作后用）。 */
  const buildState = (invalidCache = false) => {
    const now = Date.now()
    if (!invalidCache && stateCache && now - stateCacheAt < STATE_TTL_MS) {
      return { ...stateCache, autoEnabled }
    }
    // 强制刷新时扫描缓存必须一起作废——否则写操作之后会拿到
    // 1.2 秒内的旧会话列表，UI 上表现为「删了但统计没变」。
    if (invalidCache) { scanCache = null; scanCacheAt = 0 }
    const next = computeState()
    stateCache = next
    stateCacheAt = now
    return next
  }

  ctx.effect(() => {
    return ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const action = url.pathname.slice(ROUTE.length + 1)

        // ---- 所有 GET 端点必须在 405 判断之前处理 ----
        if (req.method === 'GET') {
          if (action === 'state' || action === '') return json(res, 200, buildState())

          // 诊断回读：浏览器侧把「切换主面板」的决策过程 POST 上来，
          // 这里原样返回，方便排查「点了删除但界面没反应」。
          // 只保留最近 20 条，不落盘。
          if (action === 'diag') {
            return json(res, 200, { ok: true, items: diagLog.slice(-20) })
          }

          // 数据体检：列出被 scanSessions 静默跳过的会话。
          // 这些通常是磁盘异常、文件损坏、或删到一半留下的残骸，
          // 平时看不见，只会在「备份列表少了一个」时让人困惑。
          if (action === 'audit') {
            const r = auditSessions(sessionsRoot())
            return json(res, 200, { ok: true, ...r })
          }

          // 列出「备份里有、当前会话库里已经没有」的会话
          if (action === 'restorable') {
            const all = getSessions()
            const liveIds = new Set(all.map((s) => s.header.id))
            const items = listRestorable(dshHome(), liveIds)
            const stats = backupStats(dshHome())
            // 同样补显示名。这些会话已不在磁盘，拿不到 live header，
            // 只能靠「备份记录里的标题 → projcache → 短 id」逐级降级。
            // 注意必须把 x.title 传进去：会话删了以后 projcache 也没了，
            // 备份 index.json 里的 title 往往就是唯一的线索。
            const decorated = items.map((x) => {
              const dn = displayNameOf(pc, x.id, { title: x.title })
              return { ...x, displayName: dn.name, nameKind: dn.kind }
            })
            return json(res, 200, {
              ok: true,
              items: decorated.slice(0, 200),
              total: decorated.length,
              backupCount: stats.count,
              backupBytes: stats.bytes,
            })
          }

          // 列出全部备份（含仍存在的会话），供用户自己挑着删
          if (action === 'backups') {
            // 性能：这里只需要知道「哪些会话还在磁盘上」，
            // 不需要会话的完整信息。scanSessions 要逐个读 zstd 帧头（226 个约 230ms），
            // 而直接列目录只要 2ms，两者得到的 id 集合实测完全一致。
            // 用户点开侧边栏面板时那一下卡顿就是这么来的。
            const liveIds = liveSessionIds()
            const allItems = listBackups(dshHome(), liveIds)
            const stats = backupStats(dshHome())

            // 子代理处理：不单独列出，因为它们始终挂在父会话下面，
            // 删父会话时会被级联删除（见 deleteSessionsCascade），
            // 单独列只是噪声——100 个都叫「Reply with exactly: OK」。
            //
            // 但有一个例外必须保留：**孤儿子代理**。
            // 如果父会话已经不在了（比如以前用别的方式删过），
            // 这个子代理就没人管了——它既有数据占着空间，
            // 又因为不在任何父会话下而永远不会被级联带走。
            // 这种必须能看见、能单独删，否则就是永远清不掉的垃圾。
            const subagentInfo = new Map()   // id -> { parent }
            {
              try {
                for (const s of getSessions()) {
                  if (s?.header?.origin === 'subagent') {
                    subagentInfo.set(s.header.id, { parent: s.header.parentSession })
                  }
                }
              } catch { /* ignore */ }
            }

            // 「父会话还在」的子代理 = 归入父会话，不单列
            const buriedSubagent = (id) => {
              const info = subagentInfo.get(id)
              if (!info) return false
              const p = info.parent
              // 没记父 id 的也算孤儿（没法归属，只能单独处理）
              if (typeof p !== 'string' || !p) return false
              return liveIds.has(p)          // 父会话还活着 → 归入父会话
            }

            // 先算出「该显示的全部条目」（已排除归入父会话的子代理）。
            // 两个标签页的计数必须都从这一份算，不能从过滤后的 items 算——
            // 否则切到「现存」时 items 里只有 alive 的，已删除数就成了 0，
            // 表现为「点哪个哪个才有数字」。
            const visible = allItems.filter((b) => !buriedSubagent(b.id))
            const deletedCount = visible.filter((b) => !b.alive).length
            const aliveCount = visible.filter((b) => b.alive).length
            const hiddenSubagentCount = allItems.filter((b) => buriedSubagent(b.id)).length

            // 按 alive 过滤：deleted = 会话已不在磁盘（可恢复），alive = 会话还在
            const filter = url.searchParams.get('filter') || 'all'
            let items = filter === 'deleted'
              ? visible.filter((b) => !b.alive)
              : filter === 'alive'
                ? visible.filter((b) => b.alive)
                : visible

            // 服务端分页：前端要翻页，不能只给前 N 条
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200))
            const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)

            // 给每一项补「显示名」。
            // 备份记录里的 title 是解除那一刻抓的，那时可能还没有标题；
            // 更主要的是大量空会话（创建后没说过话）DSH 根本不会生成标题，
            // projcache 里 title.val 就是 null。直接显示 id 片段用户认不出来。
            // 所以逐级降级：标题 → 工作区目录名 → 子代理标记 → 短 id。
            const decorate = (b) => {
              let origin = subagentInfo.has(b.id) ? 'subagent' : undefined
              let cwd
              if (b.alive && !origin) {
                // 只查真正在磁盘上的，而且只查这一条
                try {
                  const s = findSessionByIdWithFallback(sessionsRoot(), b.id)
                  origin = s?.header?.origin
                  cwd = s?.header?.cwd
                } catch { /* ignore */ }
              }
              const dn = displayNameOf(pc, b.id, {
                title: b.title,                 // 备份记录里的标题，优先用
                origin,
                cwd,
              })
              // title 只在现场取到真标题时才覆盖；取不到就保留备份记录里的旧值
              // （别把有效的历史标题降级成 null）
              return {
                ...b,
                isSubagent: origin === 'subagent',
                title: dn.title ?? b.title ?? null,
                displayName: dn.name,
                nameKind: dn.kind,
              }
            }

            const pageItems = items.slice(offset, offset + limit)

            return json(res, 200, {
              ok: true,
              items: pageItems.map(decorate),
              total: items.length,            // 当前 filter 下的总数（用于分页）
              grandTotal: allItems.length,    // 不过滤的总数
              deletedCount,
              aliveCount,
              hiddenSubagentCount,            // 已归入父会话、不单列的子代理数
              offset,
              limit,
              backupBytes: stats.bytes,
              retentionDays: backupRetentionDays,
            })
          }

          return json(res, 404, { ok: false, error: 'unknown-action' })
        }

        if (req.method !== 'POST') {
          return json(res, 405, { ok: false, error: 'method-not-allowed' })
        }

        const body = await readBody(req)

        if (action === 'toggle') {
          autoEnabled = body.enabled === true
          ctx.logger?.info?.(`[dsh-session-guard] 自动解除已${autoEnabled ? '开启' : '关闭'}（运行时）`)
          return json(res, 200, buildState(true))
        }

        if (action === 'detach') {
          const all = getSessions()
          // 指定了 sessionId 就只处理那一个，否则处理全部待处理
          const targets = typeof body.sessionId === 'string' && body.sessionId
            ? all.filter((s) => s.header.id === body.sessionId || s.header.id.endsWith(body.sessionId))
            : realDialogForks(all)

          if (targets.length === 0) {
            return json(res, 200, { ok: true, detached: 0, message: '没有需要解除的会话' })
          }

          const count = detachAll(targets, '手动解除', 'manual')
          return json(res, 200, { ok: true, detached: count, state: buildState(true) })
        }

        if (action === 'clear') {
          const ok = clearRecords(dshHome())
          if (!ok) return json(res, 500, { ok: false, error: 'clear-failed' })
          return json(res, 200, { ok: true, state: buildState(true) })
        }

        // POST /diag：接收浏览器侧的决策轨迹（排查「删除后界面没反应」用）
        // 只在内存里留最近 20 条，不落盘、不参与业务。
        if (action === 'diag') {
          diagLog.push({
            at: typeof body.at === 'string' ? body.at : new Date().toISOString(),
            sessionId: body.sessionId ?? null,
            ok: body.ok === true,
            hasSessions: body.hasSessions === true,
            hasUiWorkspace: body.hasUiWorkspace === true,
            canOpen: body.canOpen === true,
            trace: Array.isArray(body.trace) ? body.trace.slice(0, 20) : [],
          })
          if (diagLog.length > 20) diagLog.splice(0, diagLog.length - 20)
          return json(res, 200, { ok: true })
        }

        // ---- 备份 / 恢复（POST）----

        // POST /backup：立即备份全部会话（UI「立即备份」按钮）
        if (action === 'backup') {
          const all = getSessions()
          const r = backupSessions(dshHome(), all, {
            titleOf: (id) => titleOf(pc, id),
          })
          return json(res, 200, { ok: true, ...r })
        }

        // POST /restore：恢复指定会话
        if (action === 'restore') {
          const id = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
          if (!id) return json(res, 400, { ok: false, error: 'sessionId-required' })
          const r = restoreSession(dshHome(), sessionsRoot(), id, {
            overwrite: body.overwrite === true,
          })
          if (r.status === 'restored') return json(res, 200, { ok: true, ...r })
          if (r.status === 'exists') return json(res, 409, { ok: false, error: 'target-exists', ...r })
          if (r.status === 'missing-backup') return json(res, 404, { ok: false, error: 'no-backup', ...r })
          return json(res, 500, { ok: false, error: r.reason ?? 'restore-failed', ...r })
        }

        // POST /drop-backup：丢弃某个备份
        if (action === 'drop-backup') {
          const id = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
          if (!id) return json(res, 400, { ok: false, error: 'sessionId-required' })
          const ok = dropBackup(dshHome(), id)
          return json(res, ok ? 200 : 500, { ok })
        }

        // POST /drop-backups：批量丢弃备份（勾选删除）
        if (action === 'drop-backups') {
          const ids = Array.isArray(body.sessionIds) ? body.sessionIds : []
          if (ids.length === 0) return json(res, 400, { ok: false, error: 'sessionIds-required' })
          const r = dropBackups(dshHome(), ids)
          return json(res, 200, { ok: true, ...r, state: buildState(true) })
        }

        // POST /prune-backups：按保留天数清理过期备份。
        // 传了合法 days 就同时把它记为**用户选择**并持久化，
        // 这样刷新页面/重启后选择不会跳回配置文件里的值。
        if (action === 'prune-backups') {
          const raw = Number(body.days)
          const days = Number.isFinite(raw) && raw >= 0 ? raw : backupRetentionDays
          if (!(days > 0)) return json(res, 400, { ok: false, error: 'invalid-days' })
          if (Number.isFinite(raw) && raw >= 0) {
            backupRetentionDays = days
            writeSettings({ retentionDays: days })
          }
          const all = getSessions()
          const liveIds = new Set(all.map((s) => s.header.id))
          const r = pruneBackups(dshHome(), days, { liveIds, onlyOrphans: body.onlyOrphans !== false })
          return json(res, 200, { ok: true, days, retentionDays: days, ...r, state: buildState(true) })
        }

        // POST /settings：只改设置不触发清理（UI 选完天数立即存）
        if (action === 'settings') {
          const raw = Number(body.retentionDays)
          if (!Number.isFinite(raw) || raw < 0) return json(res, 400, { ok: false, error: 'invalid-days' })
          backupRetentionDays = raw
          const saved = writeSettings({ retentionDays: raw })
          return json(res, 200, { ok: true, retentionDays: backupRetentionDays, persisted: saved })
        }

        // POST /delete：删除会话（先备份再删，可恢复）
        if (action === 'delete') {
          const all = getSessions()
          const byId = new Map(all.map((s) => [s.header.id, s]))
          const ids = Array.isArray(body.sessionIds)
            ? body.sessionIds
            : (typeof body.sessionId === 'string' ? [body.sessionId] : [])
          if (ids.length === 0) return json(res, 400, { ok: false, error: 'sessionIds-required' })

          const targets = []
          const notFound = []
          for (const id of ids) {
            const s = byId.get(id)
            if (s) targets.push(s)
            else notFound.push(id)
          }
          // 全部 id 都找不到时，分两种情况：
          //   · 确实没见过这些 id → 404（调用方用错了）
          //   · 备份里有它们 → 说明是已经被删掉了（并发点击、重复提交）
          //     这种情况返回 200 + deleted:0，让 UI 显示「已处理」而不是报错
          if (targets.length === 0) {
            let alreadyGone = false
            try {
              const idx = readIndex(dshHome())
              alreadyGone = notFound.some((id) => idx.entries?.[id] !== undefined)
            } catch { /* ignore */ }
            if (alreadyGone) {
              return json(res, 200, {
                ok: true,
                deleted: 0,
                cascadeDeleted: 0,
                freedBytes: 0,
                busy: 0,
                failed: 0,
                notFound,
                alreadyGone: true,
                state: buildState(true),
              })
            }
            return json(res, 404, { ok: false, error: 'not-found', notFound })
          }

          const dryRun = body.confirm !== true
          // ensureBackup：删除前必须**确认备份副本真实存在**。
          // 不能只看 backupSessions 的返回值就完事——skipped 只代表"文件没变"，
          // 不代表副本还在（用户可能已经手动删掉了）。所以备份完成后直接查盘。
          const ensureBackup = (id) => {
            const s = byId.get(id)
            if (!s) return false
            try {
              const r = backupSessions(dshHome(), [s], { titleOf: (x) => titleOf(pc, x) })
              if (r.copied === 0 && r.skipped === 0) return false
              // 关键：查副本是否真的在磁盘上，且大小与源一致
              const copy = join(backupRoot(dshHome()), id, 'session.v4.jsonl.zstd')
              if (!existsSync(copy)) return false
              const srcSize = statSync(s.file).size
              const copySize = statSync(copy).size
              return srcSize === copySize
            } catch {
              return false
            }
          }

          // 级联删除：父会话删了，它的子会话（子代理、fork 分支）也一起删。
          // 否则子代理会变孤儿——DSH 侧边栏不显示它们，用户既看不见也删不掉。
          // body.cascade === false 可关掉（只删指定的那几个）。
          //
          // archiveFromList：删除前先把这个会话从 DSH 的列表状态里摘掉。
          // 顺序不能反——archiveSession 内部会校验会话是否还存在，
          // 文件删掉之后它就会抛 WorkspaceUnknownSessionError。
          const cascade = body.cascade !== false
          const r = await deleteSessionsCascade(
            targets, all, { ensureBackup, archive: archiveFromList }, { dryRun, cascade },
          )
          if (dryRun) {
            return json(res, 200, {
              ok: true,
              dryRun: true,
              planned: r.planned,
              cascadePlanned: cascade ? r.planned - targets.length : 0,
              freedBytes: r.freedBytes,
              busy: r.busy,
              failed: r.failed,
              notFound,
              message: '预演：确认后用 confirm=true 再调用一次才会真正删除。',
            })
          }
          // 归档失败的结果单独统计：这意味着「文件没删，因为删了列表也摘不掉」
          const archiveFailed = r.results.filter((x) => x.status === 'archive-failed')
          if (archiveFailed.length > 0) {
            ctx.logger?.warn?.(
              `[dsh-session-guard] ${archiveFailed.length} 个会话因无法从列表移除而中止删除：`
              + archiveFailed.map((x) => `${x.id}(${x.reason})`).join('; '),
            )
          }
          ctx.logger?.info?.(
            `[dsh-session-guard] 已删除 ${r.deleted} 个会话`
            + (r.cascadeDeleted > 0 ? `（其中 ${r.cascadeDeleted} 个是连带删除的子会话）` : '')
            + `，释放 ${(r.freedBytes / 1048576).toFixed(1)} MB`,
          )
          return json(res, 200, {
            ok: true,
            deleted: r.deleted,
            cascadeDeleted: r.cascadeDeleted,
            freedBytes: r.freedBytes,
            busy: r.busy,
            failed: r.failed,
            archiveFailed: archiveFailed.length,
            archiveErrors: archiveFailed.map((x) => ({ id: x.id, reason: x.reason })),
            listUpdated: !!workspaceRegistry,
            notFound,
            state: buildState(true),
          })
        }

        return json(res, 404, { ok: false, error: 'unknown-action' })
      } catch (error) {
        const message = String(error?.message ?? error)
        // 请求体过大 / JSON 坏 → 400，其余 500
        const code = message === 'request-too-large' || error instanceof SyntaxError ? 400 : 500
        ctx.logger?.warn?.(`[dsh-session-guard] Web 接口出错: ${message}`)
        try { json(res, code, { ok: false, error: message }) } catch { /* ignore */ }
      }
    },
    })
  }, 'dsh-session-guard: web route')
}