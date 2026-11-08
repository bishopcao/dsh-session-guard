// dsh-session-guard — 浏览器侧
//
// 两个落点：
//   1. plugins.bundle.config        —— 插件管理页卡片：自动开关 + 最近解除记录
//   2. conversation.session.header.utilities
//                                  —— 会话头部：当前会话的状态徽标 / 一键独立
//
// 数据统一走 Host 的 /session-guard 接口：
//   GET  state   当前开关 + 存活记录 + 待处理
//   POST toggle  切开关
//   POST detach  解除（可指定 sessionId）
//   POST clear   清记录
window.__ModuleLoader__.load({
  id: 'dsh-session-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    // 官方 UI 组件库（菜单项、图标都在这里）。
    // 用 try 包住：不同 DSH 版本导出可能变化，拿不到就退化为自绘按钮，
    // 而不是让整个 client 模块加载失败（那样卡片和徽标会一起消失）。
    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (error) {
      try { console.warn('[dsh-session-guard] 未能加载 ui-primitives，菜单项将退回自绘样式：', error) } catch { /* ignore */ }
    }
    const hasMenuItem = !!(primitives && primitives.MenuItemButton)
    const TrashIcon = primitives && primitives.IconTrashOutlineRegular

    // 会话服务（用来在删除后刷新侧边栏列表）。
    // 同样容错：拿不到就退化为「下次刷新生效」。
    let sessionsApi = null

    const BASE = '/session-guard'

    // ---------- 侧边栏图标区的折叠开关 ----------
    //
    // 问题：左侧栏顶部的图标列表（插件/任务看板/会话搜索…）是 DSH 硬编码的
    // <nav class="panelList">，样式是 `flex: none` —— 有几个图标就撑多高，
    // 于是图标越多，下面的「工作区」区域被挤得越小。
    //
    // DSH 没给插件改这块的插槽，但它是纯 CSS 布局问题，可以用样式表修：
    //   把 panelList 从 `flex: none` 改成可收缩 + 内部滚动，
    //   它就不会再抢工作区的空间，图标多了自己在小框里滚。
    //
    // 折叠开关（收成一条细栏）额外加：只靠 CSS 没法给 DSH 的 nav 塞按钮，
    // 所以用 MutationObserver 给它补一个「折叠」按钮挂到 nav 前面。
    // 拿不到 DOM 就直接跳过，不影响插件本身。
    const SIDEBAR_CSS_ID = 'dsh-session-guard/sidebar.css'
    const SIDEBAR_CSS = `
/* 图标区：不再按内容撑高，改成可收缩 + 自己滚。
   这样图标再多，也不会把下面的工作区挤没。 */
[data-dsh-sg-sidebar] nav[aria-label] {
  flex: 0 1 auto !important;
  overflow-y: auto !important;
  overscroll-behavior: contain;
}
/* 半折叠：不整个隐藏，只露出前 N 个图标，剩下的滚出来。
   为什么不做"全隐藏"：全隐藏后每次都要先展开才能点到插件，
   而常用的可能就那几个。

   高度由 CSS 变量 --dsh-sg-rows-h 决定（JS 按你选的行数写入），
   公式：行数 * 36 + (行数 - 1) * 行距 + 4（余量）。
   DSH 的图标行是 36px 高。
   默认 4 行 = 160px，作为变量没设上时的兜底。 */
[data-dsh-sg-sidebar][data-dsh-sg-collapsed] nav[aria-label] {
  max-height: var(--dsh-sg-rows-h, 160px) !important;
  overflow-y: auto !important;
  overflow-x: hidden !important;
  scrollbar-width: thin;
  /* 底部渐隐，暗示"下面还有" */
  mask-image: linear-gradient(to bottom, #000 calc(100% - 22px), transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 22px), transparent 100%);
}
/* 宽屏行距 12px，用另一个变量（JS 同时算好） */
@media (min-width: 1100px) {
  [data-dsh-sg-sidebar][data-dsh-sg-collapsed] nav[aria-label] {
    max-height: var(--dsh-sg-rows-h-wide, 184px) !important;
  }
}
/* 折叠按钮 */
.dsh-sg-foldbtn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  height: 24px;
  margin: 4px 0;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  border-radius: 6px;
  opacity: .85;
  flex: none;
}
.dsh-sg-foldbtn:hover {
  opacity: 1;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
`

    /** 注入样式表（只注入一次）。 */
    function injectSidebarCss() {
      try {
        if (typeof document === 'undefined') return
        if (document.querySelector(`style[data-plugin-css=${JSON.stringify(SIDEBAR_CSS_ID)}]`) !== null) return
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-session-guard'
        tag.dataset.pluginCss = SIDEBAR_CSS_ID
        tag.textContent = SIDEBAR_CSS
        document.head.appendChild(tag)
      } catch { /* ignore */ }
    }

    /**
     * 侧边栏折叠状态。
     *
     * 默认值 = **收起**（folded = true）。
     * 每次重启，左侧图标列表都是收着的，工作区拿全部空间；
     * 想看图标时点一下「展开图标 ▲」。
     *
     * 持久化：手动改过之后记住你的选择，存在值就按存的来；
     * 从来没点过（localStorage 里没这个键）才用上面的默认收起。
     *
     *   folded = true  → 图标列表收起（默认）
     *   folded = false → 图标列表展开
     */
    // key 里带 v2：旧的 key（'dsh-session-guard:sidebar-folded'）已经存过 '0'
    // 之类的值，如果继续用它，你上次点过「展开」的记录会盖掉新的默认收起。
    // 换个新 key 等于重新开始，第一次进来就走默认收起。
    const FOLD_LS_KEY = 'dsh-session-guard:sidebar-folded:v2'
    let sidebarFolded = (() => {
      try {
        const saved = window.localStorage.getItem(FOLD_LS_KEY)
        if (saved === null) return true   // 没存过 → 默认收起
        return saved === '1'
      } catch {
        return true                       // localStorage 不可用 → 也用默认收起
      }
    })()

    /** 写入折叠状态（localStorage 不可用时静默跳过）。 */
    function persistFold(v) {
      try { window.localStorage.setItem(FOLD_LS_KEY, v ? '1' : '0') } catch { /* ignore */ }
    }

    // ---------- 半折叠时露出几个图标 ----------
    //
    // DSH 图标行固定 36px 高；窄屏行距 4px、宽屏（≥1100px）12px。
    // 「露 N 个」需要的高度 = N*36 + (N-1)*行距 + 4（余量）
    // 用户可选，存 localStorage，重启保持不变。
    const ROWS_LS_KEY = 'dsh-session-guard:sidebar-rows'
    const DEFAULT_ROWS = 4
    const ROW_HEIGHT = 36

    let foldRows = (() => {
      try {
        const raw = window.localStorage.getItem(ROWS_LS_KEY)
        const n = Number(raw)
        if (!Number.isFinite(n) || n < 1) return DEFAULT_ROWS
        return Math.min(20, Math.max(1, Math.round(n)))
      } catch {
        return DEFAULT_ROWS
      }
    })()

    /** 按行数算高度（含 4px 余量）。 */
    function rowsHeight(rows, wide) {
      const gap = wide ? 12 : 4
      const n = Math.max(1, rows)
      return n * ROW_HEIGHT + (n - 1) * gap + 4
    }

    /**
     * 把行数写进侧边栏根的 CSS 变量。
     * CSS 里 `max-height: var(--dsh-sg-rows-h, 160px)` 读它。
     * 宽/窄屏各写一个变量，由媒体查询切换，窗口缩放不用重跑 JS。
     */
    function applyFoldRows() {
      try {
        const nav = findPanelNav()
        if (!nav) return false
        const col = nav.closest('[data-dsh-sidebar]') ?? nav.parentElement
        if (!col) return false
        col.style.setProperty('--dsh-sg-rows-h', `${rowsHeight(foldRows, false)}px`)
        col.style.setProperty('--dsh-sg-rows-h-wide', `${rowsHeight(foldRows, true)}px`)
        return true
      } catch {
        return false
      }
    }

    /** 设置行数并持久化。 */
    function setFoldRows(n) {
      const v = Math.min(20, Math.max(1, Math.round(Number(n) || DEFAULT_ROWS)))
      foldRows = v
      try { window.localStorage.setItem(ROWS_LS_KEY, String(v)) } catch { /* ignore */ }
      applyFoldRows()
    }

    /**
     * 给 DSH 侧边栏的图标 nav 挂上折叠开关。
     *
     * 用 MutationObserver 而不是一次性查询：侧边栏可能在启动后重建，
     * 一次查询会扑空。观察 body 的子节点变化，找到 nav 就挂上去。
     */
    /**
     * 找到 DSH 侧边栏里那个「图标列表」nav。
     *
     * 用 `nav[aria-label]`：CSS 属性选择器只判断属性**存在**，不比较值，
     * 所以本地化文案是什么都无所谓。（我一度误以为要匹配 'panels' 才行，
     * 换成了 [class*=panelList]，那是多余且引入问题的改动。）
     */
    function findPanelNav() {
      try {
        return document.querySelector('[data-dsh-sidebar] nav[aria-label]')
          ?? document.querySelector('nav[aria-label]')
      } catch {
        return null
      }
    }

    function installSidebarFold() {
      try {
        if (typeof document === 'undefined') return
        injectSidebarCss()

        /**
         * 把当前折叠状态刷到 DOM 上。
         *
         * 每次调用都重新查节点，不缓存引用 —— React 重渲染会换掉侧边栏 DOM，
         * 攥着旧引用改属性页面毫无反应（表现为「点了没反应」）。
         */
        const applyFoldState = () => {
          try {
            const nav = findPanelNav()
            if (!nav) return false
            const col = nav.closest('[data-dsh-sidebar]') ?? nav.parentElement
            if (!col) return false

            if (!col.hasAttribute('data-dsh-sg-sidebar')) col.setAttribute('data-dsh-sg-sidebar', '')
            // 只在需要时写，避免无谓的属性变更
            const has = col.hasAttribute('data-dsh-sg-collapsed')
            if (sidebarFolded && !has) col.setAttribute('data-dsh-sg-collapsed', '')
            else if (!sidebarFolded && has) col.removeAttribute('data-dsh-sg-collapsed')

            // 顺便把「露出几个」的高度写到 CSS 变量上。
            // 放在这里而不是单开一处，是为了保证「挂载 / 点击 / 改行数」三条路径
            // 都经过同一个出口，不会出现状态和高度不同步。
            col.style.setProperty('--dsh-sg-rows-h', `${rowsHeight(foldRows, false)}px`)
            col.style.setProperty('--dsh-sg-rows-h-wide', `${rowsHeight(foldRows, true)}px`)
            return true
          } catch {
            return false
          }
        }

        /** 装按钮。只做一次，不做任何轮询或观察。 */
        const mount = () => {
          if (!applyFoldState()) return false

          const nav = findPanelNav()
          if (!nav || !nav.parentElement) return false

          const col = nav.closest('[data-dsh-sidebar]') ?? nav.parentElement
          if (!col) return false

          // 已经装过就只同步文案，不重复插入
          let btn = null
          for (const child of Array.from(col.children ?? [])) {
            if (child.className && String(child.className).includes('dsh-sg-foldbtn')) {
              btn = child
              break
            }
          }
          if (btn) {
            const want = sidebarFolded ? '展开全部 ▲' : '收起部分 ▼'
            if (btn.textContent !== want) btn.textContent = want
            return true
          }

          btn = document.createElement('button')
          btn.type = 'button'
          btn.className = 'dsh-sg-foldbtn'
          btn.textContent = sidebarFolded ? '展开全部 ▲' : '收起部分 ▼'
          btn.title = sidebarFolded
            ? '展开左侧图标列表'
            : '收起左侧图标列表，给工作区腾地方'

          btn.addEventListener('click', (e) => {
            e.preventDefault()
            e.stopPropagation()
            sidebarFolded = !sidebarFolded
            persistFold(sidebarFolded)   // 记住选择，重启后保持
            // 每次重新查节点：React 可能已经重建侧边栏，闭包里那个引用早就脱离文档
            const ok = applyFoldState()
            btn.textContent = sidebarFolded ? '展开全部 ▲' : '收起部分 ▼'
            btn.title = sidebarFolded
              ? '展开左侧图标列表'
              : '收起左侧图标列表，给工作区腾地方'
            if (!ok) {
              btn.textContent = '未找到侧边栏'
              setTimeout(() => { btn.textContent = sidebarFolded ? '展开全部 ▲' : '收起部分 ▼' }, 2000)
            }
          })

          // 右键：弹出「收起时露出几个」的选择菜单。
          // 自绘浮层而非 window.prompt——样式跟宿主主题走，也不会被浏览器拦。
          btn.addEventListener('contextmenu', (e) => {
            e.preventDefault()
            e.stopPropagation()
            openRowsMenu(btn)
          })

          nav.parentElement.insertBefore(btn, nav)
          return true
        }

        /**
         * 右键按钮时弹出的行数选择菜单。
         *
         * 为什么要这个：收起状态下露出几个图标因人而异——
         * 常用 3 个的人和常用 7 个的人需求完全不同。
         * 做成可选就不必每次改代码重新打包。
         */
        const openRowsMenu = (anchor) => {
          try {
            // 先清掉可能已存在的菜单（重复右键）
            document.querySelectorAll('.dsh-sg-rowsmenu').forEach((n) => n.remove())

            const rect = anchor.getBoundingClientRect()
            const menu = document.createElement('div')
            menu.className = 'dsh-sg-rowsmenu'
            Object.assign(menu.style, {
              position: 'fixed',
              left: `${Math.max(8, rect.left)}px`,
              top: `${rect.bottom + 6}px`,
              zIndex: '2147483000',
              minWidth: '150px',
              padding: '6px',
              borderRadius: '8px',
              border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28))',
              background: 'var(--dsw-alias-bg-layer-1, #fff)',
              boxShadow: '0 8px 24px rgba(0,0,0,.16)',
              font: 'inherit',
              fontSize: '12px',
              color: 'var(--dsw-alias-label-primary, #222)',
            })

            const title = document.createElement('div')
            title.textContent = '收起时露出'
            Object.assign(title.style, {
              padding: '4px 8px 6px',
              opacity: '.62',
              fontSize: '11px',
            })
            menu.appendChild(title)

            // 候选行数：1 到 6
            const options = [1, 2, 3, 4, 5, 6]
            for (const n of options) {
              const item = document.createElement('button')
              item.type = 'button'
              const active = n === foldRows
              item.textContent = `${n} 个${active ? '  ✓' : ''}`
              Object.assign(item.style, {
                display: 'block',
                width: '100%',
                padding: '6px 8px',
                margin: '1px 0',
                border: 'none',
                borderRadius: '6px',
                background: active ? 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))' : 'transparent',
                color: 'inherit',
                font: 'inherit',
                fontSize: '12px',
                textAlign: 'left',
                cursor: 'pointer',
              })
              item.addEventListener('mouseenter', () => {
                item.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))'
              })
              item.addEventListener('mouseleave', () => {
                if (!active) item.style.background = 'transparent'
              })
              item.addEventListener('click', (ev) => {
                ev.preventDefault()
                ev.stopPropagation()
                setFoldRows(n)
                applyFoldRows()
                // 选完立刻收起菜单，并顺手把状态切到折叠（否则改了看不到效果）
                if (!sidebarFolded) {
                  sidebarFolded = true
                  persistFold(true)
                  applyFoldState()
                  const b = document.querySelector('.dsh-sg-foldbtn')
                  if (b) b.textContent = '展开全部 ▲'
                }
                menu.remove()
                document.removeEventListener('mousedown', onOutside, true)
              })
              menu.appendChild(item)
            }

            document.body.appendChild(menu)

            // 点空白处关闭
            const onOutside = (ev) => {
              if (!menu.contains(ev.target)) {
                menu.remove()
                document.removeEventListener('mousedown', onOutside, true)
              }
            }
            // 延后一帧挂，避免本次右键事件立刻把它关掉
            setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0)
          } catch { /* 浮层失败不影响折叠本身 */ }
        }

        // 只在启动时试几次（应对侧边栏还没渲染完的情况）。
        // **不使用 MutationObserver** —— 观察器 + 手动改 DOM 会和 React 渲染互相触发。
        let tries = 0
        const tryMount = () => {
          if (mount()) return
          if (++tries < 20) setTimeout(tryMount, 500)
        }
        tryMount()
      } catch { /* 拿不到 DOM 就跳过，不影响插件其余功能 */ }
    }

    // ---------- 数据获取 ----------
    async function fetchState(signal) {
      const res = await fetch(`${BASE}/state`, { signal, headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }

    async function post(action, body) {
      const res = await fetch(`${BASE}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }

    /** 轮询 state 的 hook：页面可见时才拉，避免后台空转。 */
    function useState_(intervalMs) {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const timer = useRef(null)

      const refresh = useCallback(async () => {
        try {
          const next = await fetchState()
          setState(next)
          setError(null)
        } catch (e) {
          setError(String(e.message ?? e))
        }
      }, [])

      useEffect(() => {
        refresh()
        const tick = () => {
          if (document.visibilityState === 'visible') refresh()
        }
        timer.current = setInterval(tick, intervalMs ?? 5000)
        return () => { if (timer.current) clearInterval(timer.current) }
      }, [refresh, intervalMs])

      return { state, error, refresh }
    }

    // ---------- 样式（跟宿主主题） ----------
    const S = {
      wrap: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        padding: '14px 16px',
        background: 'var(--dsw-alias-bg-layer-1)',
        marginBottom: 12,
        fontFamily: 'inherit',
      },
      head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
      title: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      sub: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 4, lineHeight: 1.5 },
      row: { display: 'flex', alignItems: 'center', gap: 8 },
      switch: { position: 'relative', width: 40, height: 22, flex: '0 0 auto', cursor: 'pointer' },
      track: (on) => ({
        position: 'absolute', inset: 0, borderRadius: 11,
        background: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
        transition: 'background .15s',
      }),
      knob: (on) => ({
        position: 'absolute', top: 2, left: on ? 20 : 2, width: 18, height: 18,
        borderRadius: '50%', background: '#fff', transition: 'left .15s',
        boxShadow: '0 1px 2px rgba(0,0,0,.2)',
      }),
      list: { marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 },
      item: {
        display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12,
        padding: '6px 8px', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
      },
      itemTitle: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      time: { flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary)', fontSize: 11 },
      badge: (kind) => ({
        fontSize: 11, padding: '1px 6px', borderRadius: 4, flex: '0 0 auto',
        color: kind === 'ok' ? 'var(--dsw-alias-state-success-primary)'
          : kind === 'warn' ? 'var(--dsw-alias-state-warn-primary)'
            : 'var(--dsw-alias-label-secondary)',
        background: 'transparent',
      }),
      btn: {
        fontSize: 12, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
      },
      btnPrimary: {
        fontSize: 12, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-brand-primary)',
        color: '#fff',
      },
      empty: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 8 },
      err: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', marginTop: 8 },
    }

    function fmtTime(ms) {
      if (!ms) return ''
      const d = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    /** 把体检的机器原因码翻成人话。 */
    function reasonText(reason) {
      const map = {
        'header-unreadable': '文件损坏',
        'no-session-file': '缺会话文件',
        'empty-dir': '空目录',
        'no-id': '缺 id',
        'id-mismatch': 'id 不一致',
        'stat-failed': '无法访问',
        'project-unreadable': '工作区不可读',
      }
      return map[reason] ?? reason
    }

    /** 字节数转人类可读。 */
    function fmtBytes(n) {
      if (!n || n < 0) return '0 B'
      if (n < 1024) return `${n} B`
      if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
      if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`
      return `${(n / 1073741824).toFixed(2)} GB`
    }

    // ---------- 1. 插件管理页卡片 ----------
    function BundleCard() {
      const { state, error, refresh } = useState_(5000)
      const [busy, setBusy] = useState(false)
      const [restorable, setRestorable] = useState([])
      const [notice, setNotice] = useState(null)
      const [backups, setBackups] = useState([])
      const [selected, setSelected] = useState(new Set())
      const [retentionDays, setRetentionDays] = useState(30)
      const [showBackups, setShowBackups] = useState(false)
      // 备份面板：两个标签页 + 各自分页
      // tab: 'deleted' = 已删除（可恢复）/ 'alive' = 现存（会话还在）
      // 分开的理由：两种东西用途完全不同——已删除的是「要不要救回来」，
      // 现存的是「要不要腾空间」，混在一列里每次都得多读一遍标签才知道该点哪。
      const [backupTab, setBackupTab] = useState('alive')
      const [pageSize, setPageSize] = useState(10)
      const [page, setPage] = useState(0)
      const [total, setTotal] = useState(0)
      // 独立会话记录自己的页码（和备份列表互不干扰）
      const [recordPage, setRecordPage] = useState(0)
      const [counts, setCounts] = useState({ deleted: 0, alive: 0 })
      // 删除备份需要二次确认：会话已删的情况下，备份是唯一还原来源
      const [confirmDrop, setConfirmDrop] = useState(false)
      // 自定义每页条数的输入框是否展开
      const [customSizeOpen, setCustomSizeOpen] = useState(false)
      // 子代理会话默认不显示（DSH 侧边栏本来也隐藏它们）。
      // 原因：这些是工具派发的 subagent，标题高度雷同（「Reply with exactly: OK」），
      // 平铺在列表里就是噪声。想看时勾选即可。
      const [showSubagent, setShowSubagent] = useState(false)
      const [hiddenSub, setHiddenSub] = useState(0)
      // 删除会话不做二次确认：后端强制先备份，天然可撤销

      // ref 镜像：loadBackups 是 useCallback([])，直接读 state 会一直是初始值，
      // 所以用 ref 拿最新值。
      const backupTabRef = useRef('alive')
      const pageSizeRef = useRef(10)
      const pageRef = useRef(0)
      const showSubagentRef = useRef(false)
      useEffect(() => { backupTabRef.current = backupTab }, [backupTab])
      useEffect(() => { pageSizeRef.current = pageSize }, [pageSize])
      useEffect(() => { pageRef.current = page }, [page])
      useEffect(() => { showSubagentRef.current = showSubagent }, [showSubagent])

      // 拉可恢复列表（备份里有、当前已经不存在的会话）
      const loadRestorable = useCallback(async () => {
        try {
          const res = await fetch(`${BASE}/restorable`, { headers: { accept: 'application/json' } })
          if (!res.ok) return
          const data = await res.json()
          setRestorable(Array.isArray(data.items) ? data.items : [])
        } catch { /* ignore */ }
      }, [])

      // 数据体检：只在用户点「检查」时跑，不占用常驻轮询
      const [audit, setAudit] = useState(null)
      const [auditBusy, setAuditBusy] = useState(false)
      const runAudit = useCallback(async () => {
        if (auditBusy) return
        setAuditBusy(true)
        try {
          const res = await fetch(`${BASE}/audit`, { headers: { accept: 'application/json' } })
          if (!res.ok) return
          setAudit(await res.json())
        } catch (e) {
          setAudit({ ok: false, scanned: 0, skipped: 0, problems: [], byReason: {}, error: String(e.message ?? e) })
        } finally { setAuditBusy(false) }
      }, [auditBusy])

      // 首次挂载时拉一次
      useEffect(() => { loadRestorable(); loadBackups(); pullRetentionOnce() }, [])

      const toggle = async () => {
        if (!state || busy) return
        setBusy(true)
        try {
          await post('toggle', { enabled: !state.autoEnabled })
          await refresh()
        } catch (e) { /* error 由 refresh 反映 */ } finally { setBusy(false) }
      }

      const detachAll = async () => {
        if (busy) return
        setBusy(true)
        try { await post('detach', {}); await refresh() } catch (e) { /* ignore */ } finally { setBusy(false) }
      }

      const clear = async () => {
        if (busy) return
        setBusy(true)
        try { await post('clear', {}); await refresh() } catch (e) { /* ignore */ } finally { setBusy(false) }
      }

      // 立即备份
      const runBackup = async () => {
        if (busy) return
        setBusy(true)
        try {
          const r = await post('backup', {})
          setNotice(`已备份 ${r.copied} 个会话（${fmtBytes(r.bytes)}），跳过 ${r.skipped} 个未变化。`)
          await refresh()
          await loadRestorable()
          await loadBackups()
        } catch (e) {
          setNotice(`备份失败：${e.message}`)
        } finally { setBusy(false) }
      }

      // 拉备份列表（服务端分页 + 按标签页过滤）
      const loadBackups = useCallback(async (over) => {
        try {
          const tab = over?.tab ?? backupTabRef.current
          const size = over?.pageSize ?? pageSizeRef.current
          const pg = over?.page ?? pageRef.current
          const showSub = over?.showSubagent ?? showSubagentRef.current
          const filter = tab === 'deleted' ? 'deleted' : 'alive'
          const url = `${BASE}/backups?filter=${filter}&limit=${size}&offset=${pg * size}`
            + (showSub ? '&includeSubagent=1' : '')
          const res = await fetch(url, { headers: { accept: 'application/json' } })
          if (!res.ok) return
          const data = await res.json()
          setBackups(Array.isArray(data.items) ? data.items : [])
          if (typeof data.total === 'number') setTotal(data.total)
          if (typeof data.deletedCount === 'number') setCounts({ deleted: data.deletedCount, alive: data.aliveCount ?? 0 })
          if (typeof data.hiddenSubagentCount === 'number') setHiddenSub(data.hiddenSubagentCount)
          // 注意：这里**不要**用返回的 retentionDays 覆盖本地选择。
          // 之前就是这么写的，导致「选了 7 天，清理完 loadBackups 又把 30 天写回去」。
          // 服务端已持久化用户选择，只在首次挂载时用 pullRetentionOnce 取一次。
        } catch { /* ignore */ }
      }, [])

      // 只在首次挂载时同步一次服务端保存的保留天数
      const pullRetentionOnce = useCallback(async () => {
        try {
          const res = await fetch(`${BASE}/backups?limit=1`, { headers: { accept: 'application/json' } })
          if (!res.ok) return
          const data = await res.json()
          if (typeof data.retentionDays === 'number') setRetentionDays(data.retentionDays)
        } catch { /* ignore */ }
      }, [])

      // 改保留天数：先存到后端，再按新值清理一次
      const changeRetention = async (days) => {
        setRetentionDays(days)             // 立即反映，不等网络
        try {
          await post('settings', { retentionDays: days })
          const r = await post('prune-backups', { days })
          if (r.removed > 0) {
            setNotice(`保留期已设为 ${days} 天，清理了 ${r.removed} 份过期备份（释放 ${fmtBytes(r.freedBytes)}）。`)
          } else {
            setNotice(`保留期已设为 ${days} 天。没有需要清理的备份。`)
          }
          await refresh()
          await loadBackups()
        } catch (e) {
          setNotice(`保存保留期失败：${e.message}`)
        }
      }

      // 清理过期备份
      const pruneOld = async () => {
        if (busy) return
        setBusy(true)
        try {
          const r = await post('prune-backups', { days: retentionDays })
          setNotice(
            r.removed > 0
              ? `已清理 ${r.removed} 份过期备份，释放 ${fmtBytes(r.freedBytes)}，保留 ${r.kept} 份。`
              : `没有需要清理的备份（保留 ${r.kept} 份）。`,
          )
          await refresh()
          await loadBackups()
        } catch (e) {
          setNotice(`清理失败：${e.message}`)
        } finally { setBusy(false) }
      }

      // 删除选中的**会话本体**（不是备份）。
      // 不做二次确认：后端在删除前会给每个会话强制做一份备份，
      // 备份副本校验不通过就一个字节都不删（见 index.js 的 ensureBackup）。
      // 所以这一步天然可撤销，删错了去「已删除」页点恢复就行。
      const deleteSelectedSessions = async () => {
        if (busy || selected.size === 0) return
        const ids = [...selected]
        setBusy(true)
        try {
          const r = await post('delete', { sessionIds: ids, confirm: true })
          setNotice(
            `已删除 ${r.deleted} 个会话，释放 ${fmtBytes(r.freedBytes)}。`
            + (r.busy > 0 ? ` ${r.busy} 个因正在运行被跳过。` : '')
            + (r.failed > 0 ? ` ${r.failed} 个失败（备份未成功，已中止）。` : '')
            + ' 需要的话可在「已删除」页恢复。',
          )
          setSelected(new Set())
          await refresh()
          await loadBackups()
          await loadRestorable()
        } catch (e) {
          setNotice(`删除失败：${e.message}`)
        } finally { setBusy(false) }
      }

      // 删除选中的备份文件。
      // 只删 ~/.dsh/session-guard-backup/<id>/ 这份副本，**不碰会话本体**。
      // 但要注意：如果会话已经被删了，这份副本就是唯一的还原来源，删了就真没了。
      // 所以走两步：第一次点只提示，第二次点才执行。
      const dropSelected = async () => {
        if (busy || selected.size === 0) return
        if (!confirmDrop) {
          setConfirmDrop(true)
          setNotice(`确认要删除这 ${selected.size} 份备份吗？再点一次「确认删除」才会执行。`)
          return
        }
        setBusy(true)
        setConfirmDrop(false)
        try {
          const r = await post('drop-backups', { sessionIds: [...selected] })
          setNotice(`已删除 ${r.dropped} 份备份${r.failed ? `，${r.failed} 份失败` : ''}。会话本身不受影响。`)
          setSelected(new Set())
          await refresh()
          await loadBackups()
          await loadRestorable()
        } catch (e) {
          setNotice(`删除备份失败：${e.message}`)
        } finally { setBusy(false) }
      }



      // 恢复一个
      const doRestore = async (id) => {
        if (busy) return
        setBusy(true)
        try {
          const r = await post('restore', { sessionId: id })
          setNotice(r.status === 'restored'
            ? `已恢复，重启 DSH 后可在会话列表看到。`
            : `恢复未完成：${r.error ?? r.status}`)
          await refresh()
          await loadRestorable()
        } catch (e) {
          setNotice(`恢复失败：${e.message}`)
        } finally { setBusy(false) }
      }

      if (error) return h('div', { style: S.wrap }, h('div', { style: S.err }, `读取状态失败：${error}`))
      if (!state) return h('div', { style: S.wrap }, h('div', { style: S.sub }, '读取中…'))

      const { autoEnabled, stats, records, pending } = state

      return h('div', { style: S.wrap },
        // 标题行 + 开关
        h('div', { style: S.head },
          h('div', null,
            h('div', { style: S.title }, '自动独立'),
            h('div', { style: S.sub },
              autoEnabled
                ? '已开启：新分支一创建就自动与父话题分离。'
                : '已关闭：新分支会保留父子关系，可在会话头部手动独立。',
            ),
          ),
          h('div', {
            style: Object.assign({}, S.switch, busy ? { opacity: 0.5 } : {}),
            role: 'switch',
            'aria-checked': autoEnabled ? 'true' : 'false',
            'aria-label': '自动独立',
            onClick: toggle,
          },
            h('div', { style: S.track(autoEnabled) }),
            h('div', { style: S.knob(autoEnabled) }),
          ),
        ),

        // 统计
        h('div', { style: Object.assign({}, S.sub, { marginTop: 10 }) },
          `会话 ${stats.totalSessions} 个 · 待独立 ${stats.pendingForks} 个 · 已记录 ${stats.recordCount} 条`,
          stats.prunedThisRead > 0 ? ` · 已自动清理 ${stats.prunedThisRead} 条失效记录` : '',
        ),

        // 待处理
        pending.length > 0
          ? h('div', { style: S.list },
            ...pending.slice(0, 5).map((p) =>
              h('div', { key: p.id, style: S.item },
                h('span', { style: S.badge('warn') }, '待独立'),
                h('span', { style: S.itemTitle }, p.title),
              ),
            ),
            h('div', { style: Object.assign({}, S.row, { marginTop: 6 }) },
              h('button', { style: S.btnPrimary, onClick: detachAll, disabled: busy }, '全部独立'),
            ),
          )
          : null,

        // 记录列表（独立会话记录）：和备份列表同一套分页逻辑
        h('div', { style: S.list },
          records.length === 0
            ? h('div', { style: S.empty }, '还没有解除记录。新分支被自动独立后会出现在这里。')
            : (() => {
              // 夹页，避免记录变少后停在空页
              const recTotalPages = Math.max(1, Math.ceil(records.length / pageSize))
              const recSafePage = Math.min(recordPage, recTotalPages - 1)
              const recStart = recSafePage * pageSize
              const recShown = records.slice(recStart, recStart + pageSize)

              const jumpTo = (n) => {
                const p = Math.min(recTotalPages, Math.max(1, n | 0)) - 1
                setRecordPage(p)
              }

              return [
                ...recShown.map((r) =>
                  h('div', { key: r.id, style: S.item },
                    h('span', { style: S.badge('ok') }, '已独立'),
                    h('span', { style: S.itemTitle, title: r.id }, r.displayName ?? r.title ?? r.id.slice(0, 12)),
                    h('span', { style: S.time }, fmtTime(r.at)),
                  ),
                ),

                // 分页：记录数超过一页才显示
                records.length > pageSize
                  ? h('div', { style: Object.assign({}, S.row, { marginTop: 8, flexWrap: 'wrap' }) },
                    h('button', {
                      style: Object.assign({}, S.btn, recSafePage === 0 ? { opacity: 0.4 } : {}),
                      onClick: () => setRecordPage(0),
                      disabled: recSafePage === 0,
                    }, '首页'),
                    h('button', {
                      style: Object.assign({}, S.btn, recSafePage === 0 ? { opacity: 0.4 } : {}),
                      onClick: () => setRecordPage(Math.max(0, recSafePage - 1)),
                      disabled: recSafePage === 0,
                    }, '上一页'),
                    h('span', { style: S.sub }, '跳至'),
                    h('input', {
                      key: `rec-jump-${recSafePage}`,
                      type: 'number',
                      min: 1,
                      max: recTotalPages,
                      defaultValue: String(recSafePage + 1),
                      onKeyDown: (e) => {
                        if (e.key !== 'Enter') return
                        jumpTo(Number(e.target.value) || 1)
                        e.currentTarget.blur()
                      },
                      onBlur: (e) => {
                        const n = Math.min(recTotalPages, Math.max(1, Number(e.target.value) || 1))
                        if (n - 1 === recSafePage) { e.target.value = String(recSafePage + 1); return }
                        setRecordPage(n - 1)
                      },
                      style: {
                        width: 56, boxSizing: 'border-box',
                        background: 'transparent', border: '1px solid var(--dsw-alias-border-l2)',
                        borderRadius: 6, font: 'inherit', fontSize: 12,
                        color: 'var(--dsw-alias-label-primary)', padding: '2px 4px',
                      },
                    }),
                    h('span', { style: S.sub }, `/ ${recTotalPages} 页 · 共 ${records.length} 条`),
                    h('button', {
                      style: Object.assign({}, S.btn, recSafePage >= recTotalPages - 1 ? { opacity: 0.4 } : {}),
                      onClick: () => setRecordPage(Math.min(recTotalPages - 1, recSafePage + 1)),
                      disabled: recSafePage >= recTotalPages - 1,
                    }, '下一页'),
                    h('button', {
                      style: Object.assign({}, S.btn, recSafePage >= recTotalPages - 1 ? { opacity: 0.4 } : {}),
                      onClick: () => setRecordPage(recTotalPages - 1),
                      disabled: recSafePage >= recTotalPages - 1,
                    }, '末页'),
                  )
                  : null,

                h('div', { style: Object.assign({}, S.row, { marginTop: 6 }) },
                  h('button', { style: S.btn, onClick: clear, disabled: busy }, '清空记录'),
                ),
              ]
            })(),
        ),

        // ---------- 数据体检 ----------
        // 扫描过程里有些会话会因为磁盘异常被静默跳过，用户看不到任何提示。
        // 这里给一个按钮，点一下就知道「有没有读不出来的会话」。
        h('div', { style: Object.assign({}, S.list, { marginTop: 14 }) },
          h('div', { style: Object.assign({}, S.row, { justifyContent: 'space-between' }) },
            h('div', null,
              h('div', { style: S.title }, '数据体检'),
              h('div', { style: S.sub },
                audit === null
                  ? '检查有没有读不出来的会话文件（磁盘异常、损坏、删到一半的残骸）。'
                  : audit.error
                    ? `检查失败：${audit.error}`
                    : audit.ok
                      ? `正常：${audit.scanned} 个会话全部可读。`
                      : `发现 ${audit.skipped} 个问题（${audit.scanned} 个正常）`),
            ),
            h('button', { style: S.btn, onClick: runAudit, disabled: auditBusy },
              auditBusy ? '检查中…' : '检查'),
          ),

          // 有问题才展开明细
          audit && !audit.ok && !audit.error
            ? [
              // 按原因归类
              ...Object.entries(audit.byReason ?? {}).map(([reason, count]) =>
                h('div', { key: reason, style: Object.assign({}, S.sub, { marginTop: 6 }) },
                  `· ${reasonText(reason)}：${count} 个`),
              ),
              // 明细（最多 10 条）
              ...(audit.problems ?? []).slice(0, 10).map((p, i) =>
                h('div', { key: `${p.seg}-${i}`, style: S.item },
                  h('span', { style: S.badge('warn') }, reasonText(p.reason)),
                  h('span', { style: S.itemTitle, title: p.dir }, p.seg || p.proj || '(未知)'),
                  h('span', { style: S.time }, (p.detail ?? '').slice(0, 40)),
                ),
              ),
              (audit.problems ?? []).length > 10
                ? h('div', { style: Object.assign({}, S.sub, { marginTop: 4 }) },
                  `…还有 ${audit.problems.length - 10} 个`)
                : null,
              h('div', { style: Object.assign({}, S.sub, { marginTop: 6, opacity: 0.75 }) },
                '这些问题不影响其他会话；多数是删除过程中断或磁盘异常留下的残骸。'),
            ]
            : null,
        ),

        // ---------- 孤儿子代理体检 ----------
        // 只在真的发现问题时才显示，正常情况一个字都不占。
        (() => {
          const orphans = state.orphanSubagents ?? []
          if (orphans.length === 0) return null
          const totalBytes = orphans.reduce((n, o) => n + (o.size ?? 0), 0)
          return h('div', { style: Object.assign({}, S.list, { marginTop: 14 }) },
            h('div', { style: Object.assign({}, S.row, { justifyContent: 'space-between' }) },
              h('div', null,
                h('div', { style: S.title }, `发现 ${orphans.length} 个孤儿子代理`),
                h('div', { style: S.sub },
                  `这些子代理的父会话已经不在了，永远不会被级联删除，`
                  + `又因为 DSH 侧边栏隐藏子代理而看不见。占 ${fmtBytes(totalBytes)}。`,
                ),
              ),
              h('button', {
                style: S.btn,
                onClick: runBackup,
                disabled: busy,
              }, '先备份'),
            ),
            ...orphans.slice(0, 8).map((o) =>
              h('div', { key: o.id, style: S.item },
                h('span', { style: S.badge('warn') }, '孤儿'),
                h('span', { style: S.itemTitle, title: o.id },
                  o.title ?? o.id.slice(0, 16)),
                h('span', { style: S.time }, fmtBytes(o.size ?? 0)),
              ),
            ),
            orphans.length > 8
              ? h('div', { style: Object.assign({}, S.sub, { marginTop: 4 }) },
                `…还有 ${orphans.length - 8} 个`)
              : null,
            h('div', { style: Object.assign({}, S.row, { marginTop: 8 }) },
              h('button', {
                style: S.btn,
                onClick: async () => {
                  if (busy) return
                  setBusy(true)
                  try {
                    const ids = orphans.map((o) => o.id)
                    const r = await post('delete', { sessionIds: ids, confirm: true })
                    setNotice(`已清理 ${r.deleted} 个孤儿子代理，释放 ${fmtBytes(r.freedBytes)}。`)
                    await refresh()
                    await loadBackups()
                  } catch (e) {
                    setNotice(`清理失败：${e.message}`)
                  } finally { setBusy(false) }
                },
                disabled: busy,
              }, `清理全部（${orphans.length} 个）`),
              h('span', { style: S.sub }, '清理前会自动备份，可从「已删除」页恢复'),
            ),
          )
        })(),

        // ---------- 备份与恢复 ----------
        // 归档插件删会话是 rmSync 直删、不进回收站，所以这里留副本才能救回来。
        h('div', { style: Object.assign({}, S.list, { marginTop: 14 }) },
          h('div', { style: Object.assign({}, S.row, { justifyContent: 'space-between' }) },
            h('div', null,
              h('div', { style: S.title }, '误删恢复'),
              h('div', { style: S.sub },
                state.backup && state.backup.count > 0
                  ? `已备份 ${state.backup.count} 个会话（${fmtBytes(state.backup.bytes)}）`
                  : '还没有备份。点击「立即备份」把当前会话留一份副本。',
              ),
            ),
            h('button', { style: S.btn, onClick: runBackup, disabled: busy }, '立即备份'),
          ),

          notice
            ? h('div', { style: Object.assign({}, S.sub, { color: 'var(--dsw-alias-label-primary)', marginTop: 8 }) }, notice)
            : null,

          restorable.length > 0
            ? [
              h('div', { style: Object.assign({}, S.sub, { marginTop: 10 }) },
                `发现 ${restorable.length} 个已删除但仍在备份里的会话：`),
              ...restorable.slice(0, 10).map((x) =>
                h('div', { key: x.id, style: S.item },
                  h('span', { style: S.badge('warn') }, '可恢复'),
                  h('span', { style: Object.assign({}, S.itemTitle, x.nameKind && x.nameKind !== 'title' ? { color: 'var(--dsw-alias-label-secondary)', fontStyle: 'italic' } : {}), title: x.id }, x.displayName ?? x.title ?? x.id.slice(0, 16)),
                  h('span', { style: S.time }, fmtTime(x.backedAt)),
                  h('button', { style: S.btn, onClick: () => doRestore(x.id), disabled: busy }, '恢复'),
                ),
              ),
            ]
            : h('div', { style: Object.assign({}, S.empty, { marginTop: 8 }) },
              '没有需要恢复的会话。被删掉的会话如果备份过，会出现在这里。'),

          // ---- 备份管理（折叠）----
          h('div', { style: Object.assign({}, S.row, { marginTop: 10, justifyContent: 'space-between' }) },
            h('button', {
              style: S.btn,
              onClick: () => { const next = !showBackups; setShowBackups(next); if (next) loadBackups() },
            }, showBackups ? '收起备份列表' : `管理备份（${backups.length || (state.backup?.count ?? 0)}）`),
            h('div', { style: S.row },
              h('span', { style: S.sub }, '保留'),
              h('select', {
                value: String(retentionDays),
                onChange: (e) => { changeRetention(Number(e.target.value)) },
                style: {
                  background: 'transparent', border: '1px solid var(--dsw-alias-border-l2)',
                  borderRadius: 6, font: 'inherit', fontSize: 12,
                  color: 'var(--dsw-alias-label-primary)', padding: '2px 4px',
                },
              }, [7, 15, 30, 60, 90, 180].map((d) => h('option', { key: d, value: String(d) }, `${d} 天`))),
              h('button', { style: S.btn, onClick: pruneOld, disabled: busy }, '清理过期'),
            ),
          ),

          showBackups
            ? (() => {
              // 按标签页过滤
              // 服务端已按 tab 过滤并分页，这里的 backups 就是当前页的那几条。
              // 总数用服务端返回的 total，不要用 backups.length（那只是本页条数）。
              const list = backups
              const totalPages = Math.max(1, Math.ceil(total / pageSize))
              const safePage = Math.min(page, totalPages - 1)
              const shown = list

              return [
                // 标签页：顺序是「现存」在前——那是日常要看的；
                // 「已删除」只在出事时用，放后面。
                h('div', { style: Object.assign({}, S.row, { marginTop: 8 }) },
                  h('button', {
                    style: Object.assign({}, S.btn, backupTab === 'alive' ? { fontWeight: 600, borderColor: 'var(--dsw-alias-state-business-primary)' } : {}),
                    onClick: () => { setBackupTab('alive'); setPage(0); loadBackups({ tab: 'alive', page: 0 }) },
                  }, `现存（${counts.alive}）`),
                  h('button', {
                    style: Object.assign({}, S.btn, backupTab === 'deleted' ? { fontWeight: 600, borderColor: 'var(--dsw-alias-state-business-primary)' } : {}),
                    onClick: () => { setBackupTab('deleted'); setPage(0); loadBackups({ tab: 'deleted', page: 0 }) },
                  }, `已删除（${counts.deleted}）`),
                  // 子代理不单独列出。
                  // 理由：它们始终挂在某个父会话下，删父会话时会一起删（级联），
                  // 单独列出来只是噪声——100 个都叫「Reply with exactly: OK」。
                  // 后端已经把「父会话还在」的子代理过滤掉了；
                  // 只有父会话已经不存在的孤儿子代理才会显示在这里（那种必须能单独处理）。
                  hiddenSub > 0
                    ? h('span', {
                      style: Object.assign({}, S.sub, { marginLeft: 8, opacity: 0.7 }),
                      title: '这些子代理已随父会话一起管理，不单独列出',
                    }, `· ${hiddenSub} 个子代理已归入父会话`)
                    : null,
                  h('div', { style: { flex: 1 } }),
                  // 每页条数：预设几档 + 自定义数字输入
                  h('span', { style: S.sub }, '每页'),
                  h('select', {
                    value: String(pageSize),
                    onChange: (e) => {
                      const v = e.target.value
                      if (v === 'custom') { setCustomSizeOpen(true); return }
                      const n = Number(v)
                      setCustomSizeOpen(false)
                      setPageSize(n); setPage(0); loadBackups({ pageSize: n, page: 0 })
                    },
                    style: {
                      background: 'transparent', border: '1px solid var(--dsw-alias-border-l2)',
                      borderRadius: 6, font: 'inherit', fontSize: 12,
                      color: 'var(--dsw-alias-label-primary)', padding: '2px 4px',
                    },
                  }, [10, 20, 50, 100, 200].map((n) => h('option', { key: n, value: String(n) }, String(n)))
                    .concat([h('option', { key: 'custom', value: 'custom' }, '自定义…')])
                    .concat(customSizeOpen ? [h('option', { key: 'cur', value: String(pageSize) }, String(pageSize))] : [])),
                  customSizeOpen
                    ? h('input', {
                      type: 'number',
                      min: 1,
                      max: 500,
                      defaultValue: String(pageSize),
                      placeholder: '1-500',
                      onKeyDown: (e) => {
                        if (e.key !== 'Enter') return
                        const n = Math.max(1, Math.min(500, Number(e.target.value) || 20))
                        setCustomSizeOpen(false)
                        setPageSize(n); setPage(0); loadBackups({ pageSize: n, page: 0 })
                      },
                      onBlur: (e) => {
                        const n = Math.max(1, Math.min(500, Number(e.target.value) || 20))
                        if (n === pageSize) { setCustomSizeOpen(false); return }
                        setCustomSizeOpen(false)
                        setPageSize(n); setPage(0); loadBackups({ pageSize: n, page: 0 })
                      },
                      style: {
                        width: 64, boxSizing: 'border-box',
                        background: 'transparent', border: '1px solid var(--dsw-alias-border-l2)',
                        borderRadius: 6, font: 'inherit', fontSize: 12,
                        color: 'var(--dsw-alias-label-primary)', padding: '2px 4px',
                      },
                    })
                    : null,
                ),

                // 说明
                h('div', { style: Object.assign({}, S.sub, { marginTop: 6 }) },
                  backupTab === 'deleted'
                    ? '这些会话文件已经不在磁盘上，点「恢复」可以放回去。「删除选中备份」只是删掉这份副本 —— 删了就再也恢复不了了。'
                    : '这些会话还在磁盘上。「删除选中会话」会先自动备份再删除，删掉后可在「已删除」页恢复；「删除选中备份」只删副本，会话本身不受影响。'),

                // 空状态
                total === 0
                  ? h('div', { style: Object.assign({}, S.empty, { marginTop: 8 }) },
                    backupTab === 'deleted' ? '没有被删除的会话。' : '没有现存会话的备份。')
                  : null,

                // 列表
                ...shown.map((b) =>
                  h('label', { key: b.id, style: Object.assign({}, S.item, { cursor: 'pointer' }) },
                    h('input', {
                      type: 'checkbox',
                      checked: selected.has(b.id),
                      onChange: () => {
                        setSelected((prev) => {
                          const next = new Set(prev)
                          if (next.has(b.id)) next.delete(b.id)
                          else next.add(b.id)
                          return next
                        })
                      },
                    }),
                    h('span', { style: S.badge(b.alive ? 'ok' : 'warn') }, b.alive ? '会话在' : '已删除'),
                    // displayName 由服务端逐级降级算好（标题 → 工作区目录 → 子代理 → 短 id），
                    // title 属性里放完整 id，方便需要时核对
                    h('span', {
                      style: Object.assign({}, S.itemTitle, b.nameKind && b.nameKind !== 'title'
                        ? { color: 'var(--dsw-alias-label-secondary)', fontStyle: 'italic' }
                        : {}),
                      title: b.id,
                    }, b.displayName ?? b.title ?? b.id.slice(0, 16)),
                    h('span', { style: S.time }, fmtBytes(b.size)),
                    h('span', { style: S.time }, fmtTime(b.backedAt)),
                    b.alive
                      ? null
                      : h('button', {
                        style: S.btn,
                        onClick: (e) => { e.preventDefault(); e.stopPropagation(); doRestore(b.id) },
                        disabled: busy,
                      }, '恢复'),
                  ),
                ),

                // 分页控件：首页 / 上一页 / 跳页输入 / 下一页 / 末页
                total > pageSize
                  ? h('div', { style: Object.assign({}, S.row, { marginTop: 8, flexWrap: 'wrap' }) },
                    h('button', {
                      style: Object.assign({}, S.btn, safePage === 0 ? { opacity: 0.4 } : {}),
                      onClick: () => { setPage(0); loadBackups({ page: 0 }) },
                      disabled: safePage === 0,
                    }, '首页'),
                    h('button', {
                      style: Object.assign({}, S.btn, safePage === 0 ? { opacity: 0.4 } : {}),
                      onClick: () => { const p = Math.max(0, safePage - 1); setPage(p); loadBackups({ page: p }) },
                      disabled: safePage === 0,
                    }, '上一页'),

                    // 跳页：输入框 + 回车/失焦生效
                    h('span', { style: S.sub }, '跳至'),
                    h('input', {
                      key: `jump-${safePage}`,        // 换页后重建，让 defaultValue 跟上
                      type: 'number',
                      min: 1,
                      max: totalPages,
                      defaultValue: String(safePage + 1),
                      onKeyDown: (e) => {
                        if (e.key !== 'Enter') return
                        const n = Math.min(totalPages, Math.max(1, Number(e.target.value) || 1))
                        const p = n - 1
                        setPage(p); loadBackups({ page: p })
                        e.currentTarget.blur()
                      },
                      onBlur: (e) => {
                        const n = Math.min(totalPages, Math.max(1, Number(e.target.value) || 1))
                        const p = n - 1
                        if (p === safePage) { e.target.value = String(safePage + 1); return }
                        setPage(p); loadBackups({ page: p })
                      },
                      style: {
                        width: 56, boxSizing: 'border-box',
                        background: 'transparent', border: '1px solid var(--dsw-alias-border-l2)',
                        borderRadius: 6, font: 'inherit', fontSize: 12,
                        color: 'var(--dsw-alias-label-primary)', padding: '2px 4px',
                      },
                    }),
                    h('span', { style: S.sub }, `/ ${totalPages} 页 · 共 ${total} 条`),

                    h('button', {
                      style: Object.assign({}, S.btn, safePage >= totalPages - 1 ? { opacity: 0.4 } : {}),
                      onClick: () => { const p = Math.min(totalPages - 1, safePage + 1); setPage(p); loadBackups({ page: p }) },
                      disabled: safePage >= totalPages - 1,
                    }, '下一页'),
                    h('button', {
                      style: Object.assign({}, S.btn, safePage >= totalPages - 1 ? { opacity: 0.4 } : {}),
                      onClick: () => { const p = totalPages - 1; setPage(p); loadBackups({ page: p }) },
                      disabled: safePage >= totalPages - 1,
                    }, '末页'),
                  )
                  : null,

                // 批量操作
                h('div', { style: Object.assign({}, S.row, { marginTop: 8, flexWrap: 'wrap' }) },
                  // 「现存」页才显示删除会话：这里选中的是活着的会话
                  backupTab === 'alive'
                    ? h('button', {
                      style: Object.assign({}, S.btn, selected.size === 0 ? { opacity: 0.5 } : {}),
                      onClick: deleteSelectedSessions,
                      disabled: busy || selected.size === 0,
                      title: '删除前会自动备份，删错了可以在「已删除」页恢复',
                    }, `删除选中会话${selected.size > 0 ? `（${selected.size} 个）` : ''}`)
                    : null,

                  h('button', {
                    style: Object.assign({}, S.btn, selected.size === 0 ? { opacity: 0.5 } : {},
                      confirmDrop ? { borderColor: 'var(--dsw-alias-state-error-primary)', fontWeight: 600 } : {}),
                    onClick: dropSelected,
                    disabled: busy || selected.size === 0,
                  }, confirmDrop
                    ? `确认删除 ${selected.size} 份备份`
                    : `删除选中备份${selected.size > 0 ? `（${selected.size} 份）` : ''}`),
                  confirmDrop
                    ? h('button', { style: S.btn, onClick: () => { setConfirmDrop(false); setNotice(null) } }, '取消')
                    : null,
                  h('button', {
                    style: S.btn,
                    onClick: () => setSelected(new Set(list.map((b) => b.id))),
                  }, backupTab === 'deleted' ? '全选本页组' : '全选本组'),
                  h('button', { style: S.btn, onClick: () => setSelected(new Set()) }, '取消选择'),
                ),
              ]
            })()
            : null,
        ),
      )
    }

    // ---------- 2. 会话头部：状态徽标 / 一键独立 ----------
    function HeaderBadge({ sessionId }) {
      const { state, refresh } = useState_(6000)
      const [busy, setBusy] = useState(false)
      const [flash, setFlash] = useState(null)

      const detachMe = async () => {
        if (busy || !sessionId) return
        setBusy(true)
        try {
          const r = await post('detach', { sessionId })
          setFlash(r.detached > 0 ? '已独立' : '无需处理')
          await refresh()
          setTimeout(() => setFlash(null), 2500)
        } catch (e) { setFlash('失败') } finally { setBusy(false) }
      }

      if (!state || !sessionId) return null

      const isPending = (state.pending ?? []).some((p) => p.id === sessionId)
      const myRecord = (state.records ?? []).find((r) => r.id === sessionId)

      // 还有父关系 → 待独立
      if (isPending) {
        return h('div', { style: S.row, title: '这个会话还挂在父话题下，删除父话题会连带删除它' },
          h('span', { style: S.badge('warn') }, flash ?? '待独立'),
          h('button', {
            style: S.btnPrimary,
            onClick: detachMe,
            disabled: busy,
            title: '让这个会话与父话题分离',
          }, busy ? '…' : '独立'),
        )
      }

      // 有记录 → 已独立
      if (myRecord) {
        return h('div', { style: S.row, title: `已于 ${fmtTime(myRecord.at)} 与父话题分离` },
          h('span', { style: S.badge('ok') }, '已独立'),
        )
      }

      // 本来就不是 fork（根会话）
      return null
    }

    // ---------- 3. 侧边栏会话菜单：删除会话 ----------
    //
    // 挂到 DSH 官方的 sidebar.workspaces.session.menu.item 插槽，
    // 会拿到 { sessionId, displayTitle }。
    //
    // 两个要点：
    //   1. 外观必须用官方的 MenuItemButton + 图标，自己手搓 button 会和
    //      菜单里其他项对不上（间距、字号、对齐全不一样）。
    //   2. 删完必须 await sessions.refresh()。本插件直接改文件系统、
    //      绕过了 DSH 服务端，侧边栏的 sessions.list 还是旧快照；
    //      不刷新的话被删的会话会一直留在列表上（要手动刷页面才消失）。
    function DeleteSessionMenuItem({ sessionId, displayTitle }) {
      const [busy, setBusy] = useState(false)

      const onDelete = async () => {
        if (busy || !sessionId) return
        setBusy(true)
        try {
          const r = await post('delete', { sessionId, confirm: true })
          if (r.deleted > 0) {
            // 让 DSH 重新拉一次会话列表
            try { await sessionsApi?.refresh?.() } catch { /* 拿不到服务就退化为下次刷新生效 */ }
          }
        } catch (e) {
          try { console.warn('[dsh-session-guard] 删除会话失败：', e) } catch { /* ignore */ }
        } finally {
          setBusy(false)
        }
      }

      // 优先用官方 MenuItemButton（和「归档会话」等项完全一致）；
      // 万一 primitives 不可用，退回一个最简按钮，至少功能还在。
      if (hasMenuItem) {
        return h(primitives.MenuItemButton, {
          icon: TrashIcon ? h(TrashIcon, { size: 14 }) : undefined,
          onSelect: onDelete,
          children: busy ? '删除中…' : '删除会话',
        })
      }

      return h('button', {
        type: 'button',
        onClick: onDelete,
        disabled: busy,
        title: displayTitle ? `删除「${displayTitle}」（删除前会自动备份）` : '删除前会自动备份',
        style: {
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          padding: '7px 12px', border: 'none', background: 'transparent',
          font: 'inherit', fontSize: 13, lineHeight: '18px', textAlign: 'left',
          cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
          color: 'var(--dsw-alias-label-primary)', borderRadius: 6,
        },
      }, busy ? '删除中…' : '删除会话')
    }

    // ---------- 4. 侧边栏入口 ----------

    // 左侧栏图标：盾牌轮廓，和「会话搜索」那类保持一致的手绘风格。
    function GuardSidebarIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 18
      const active = props && props.active === true
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        'aria-hidden': true,
        style: { display: 'block', opacity: active ? 1 : 0.72 },
      },
        h('path', {
          d: 'M12 3.2 19 6v6.1c0 4.2-2.8 7.4-7 8.7-4.2-1.3-7-4.5-7-8.7V6l7-2.8Z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M9 12.2l2.1 2.1 4-4.2',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    // 中央面板：把插件卡片整套搬过来（卡片本身自包含，直接复用）。
    // 外面包一层滚动容器，避免内容多了溢出。
    function GuardMainPanel() {
      return h('div', {
        style: {
          height: '100%',
          minHeight: 0,
          overflowY: 'auto',
          padding: '20px 24px 16px',
          boxSizing: 'border-box',
        },
      }, h(BundleCard))
    }

    return {
      // sessions 是必须的：删除后要调它的 refresh() 刷新侧边栏列表。
      // 声明在 inject 里，Cordis 会等这个服务就绪再调 apply。
      inject: ['slots', 'sessions'],
      apply(ctx) {
        // 拿会话服务：删除后要用它的 refresh() 让侧边栏重新拉列表。
        // 拿不到不影响删除本身，只是列表要等下次刷新才消失。
        try {
          sessionsApi = typeof ctx.get === 'function' ? ctx.get('sessions') : null
        } catch {
          sessionsApi = null
        }

        // 侧边栏图标区：加折叠开关（纯 CSS 控制显示 + 一个按钮切换）
        //
        // 历史教训（0.7.5~0.7.6 踩过）：那时用 MutationObserver 监听 body 全树，
        // 回调里又改属性、又 removeChild，和 React 自己的渲染互相触发，
        // 结果左侧栏持续闪烁。现在彻底不用观察器：
        //   · 只在启动时尝试挂载几次（应对侧边栏渲染晚于插件加载）
        //   · 挂上之后不再做任何 DOM 写入，除非用户点按钮
        try { installSidebarFold() } catch { /* ignore */ }

        // ---------- 插槽注册 ----------
        //
        // 每个插槽单独包 try：宿主版本不同，插槽可能整个不存在。
        // 实测（_slot.mjs）：一次 inject 抛异常会中断整个 factory，
        // 后面的插槽全都注册不上——所以不能裸调，也不能只包一组。
        //
        // 缺哪个就少哪块 UI，其余照常工作：
        //   缺 plugins.bundle.config          → 没有插件卡片
        //   缺 conversation.session.header     → 没有会话头部徽标
        //   缺 sidebar...session.menu.item     → 会话菜单没有「删除」项
        //   缺 sidebar.panellist / main        → 没有侧边栏面板
        // Host 侧的 /session-guard 接口和两个工具不受影响。
        const mountSlot = (name, fn) => {
          try {
            ctx.slots.inject(name, fn)
          } catch (error) {
            try {
              console.warn(`[dsh-session-guard] 插槽 ${name} 不可用，跳过该区块：`, String(error?.message ?? error))
            } catch { /* ignore */ }
          }
        }

        // 插件管理页卡片
        mountSlot('plugins.bundle.config', function* () {
          yield ctx.slots.register(
            { name: 'plugins.bundle.config', key: 'dsh-session-guard' },
            BundleCard,
          )
        })

        // 会话头部徽标
        mountSlot('conversation.session.header.utilities', function* () {
          yield ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'session-guard-badge', order: -3 },
            HeaderBadge,
          )
        })

        // 侧边栏会话菜单：加一条「删除会话」
        // 这个插槽是 DSH 官方开放的扩展点，会传入 { sessionId, displayTitle }。
        mountSlot('sidebar.workspaces.session.menu.item', function* () {
          yield ctx.slots.register(
            { name: 'sidebar.workspaces.session.menu.item', id: 'session-guard-delete', order: 100 },
            DeleteSessionMenuItem,
          )
        })

        // 侧边栏面板：把整套界面搬到左侧栏
        //   sidebar.panellist → 左侧栏一个图标
        //   main              → 点开后接管中央面板
        mountSlot('sidebar.panellist', function* () {
          yield ctx.slots.register(
            { name: 'sidebar.panellist', id: 'session-guard', order: 36, label: '会话守护' },
            GuardSidebarIcon,
          )
        })
        mountSlot('main', function* () {
          yield ctx.slots.register(
            { name: 'main', key: 'session-guard' },
            GuardMainPanel,
          )
        })
      },
    }
  },
})
