# dsh-session-guard · 会话守护

**防止 DSH 删父话题时把子会话一起删掉；万一已经被删，也能捞回来。**

---

## 解决什么问题

DSH 支持从一条对话分出新分支（`Ctrl+Alt+F`）。子会话会在 header 里记下 `parentSession`，而归档插件把每个子会话都当成"可丢弃的后代"：**删掉父话题，整族一起 `rmSync`，直接落盘、不进回收站。**

于是"清理一下已归档话题"这一下点击，就可能无声地毁掉你从没归档过的对话。

这个插件布了两道防线，外加一张兜底网。

### 一、预防 —— 分支一建立就断开链接

分支创建瞬间会触发 `session/created`，插件在**这个关系还没起任何作用之前**就把 header 里的 `parentSession` 清掉。之后删父话题，在数据结构上已经找不到这个"后代"了。

插件装之前就存在的历史分支，靠启动时的一次扫描补齐。

**子代理会话（`origin === "subagent"`）完全不动** —— 它们的父子关系是运行时的正常结构。

### 二、补救 —— 本地留一份副本

预防之外，还有别的东西会删会话。所以插件会把每个还活着的会话增量备份到 `~/.dsh/session-guard-backup/`。

- 首次全量复制（真实环境 275 个会话 / 549 MB，耗时 573 ms）
- 之后只复制大小或 mtime 变化的文件（38 ms）
- 被删掉的会话会出现在恢复列表里，可逐字节还原

---

## 安装

```bash
dsh plugin --profile desktop add dsh-session-guard
```

或直接写进 `~/.dsh/profiles/<profile>/package.json`：

```json
{
  "dependencies": { "dsh-session-guard": "1.0.2" },
  "dsh": { "profile": { "bundles": ["dsh-session-guard"] } }
}
```

装完重启 DSH。

## 兼容性

**实测版本：DSH `0.2.1-rc.2`，Node `^22.19.0` / `>=24.0.0`。**

`package.json` 里写的是 `engines.dsh: ">=0.2.1-rc.2"` —— 这是**实际跑过的版本**，不是验证过的下限。更旧的版本也许能用，但没测过。

DSH 插件的扩展点会随版本出现、消失或改 props。本插件用到 5 个客户端插槽，**每一个都在各自的 `try` 里独立注册**，所以少一个插槽只少一块界面，不会拖垮整个插件：

| 缺失的插槽 | 你会少什么 |
|---|---|
| `plugins.bundle.config` | 插件卡片 |
| `conversation.session.header.utilities` | 会话头部徽标 |
| `sidebar.workspaces.session.menu.item` | 会话菜单里的「删除会话」|
| `sidebar.panellist` / `main` | 侧边栏面板 |

Host 侧（两个工具、`/session-guard/*` 接口、备份与解除逻辑）不受客户端插槽影响，缺插槽时照常工作。

会话文件的布局是 `sessions/<项目>/<会话id>/session.v4.jsonl.zstd`。文件名里的 `v4` 是格式版本；如果某个 DSH 版本把它改了，`scanSessions()` 会在**数据体检**里把那些会话列为读不出来，而不是静默出错。

## 配置

`cordis.patch.yml`：

```yaml
- insert:
    - id: session-guard
      name: dsh-session-guard
      config:
        autoDetachOnMount: true   # 启动时解除历史分支的父子关系
        backupOnMount: true       # 启动时做一次增量备份
```

两项在插件卡片里也都有运行时开关。

---

## 在哪能看到

**侧边栏图标**（盾牌）—— 点开在中央区域显示完整面板。

**插件卡片**（`插件` 页 → `dsh-session-guard`）
- 自动独立开关
- 最近的解除记录（会话没了会自动清掉），带分页
- **数据体检** —— 找出损坏、删了一半、读不出来的会话文件
- **孤儿子代理** —— 父会话已经不在了的那些，支持一键清理
- 备份管理：现存 / 已删除两个标签页、分页、每页条数、恢复、删除
- **删除会话** —— 会连带删除子代理和 fork 后代

**会话头部** —— 一个徽标，显示当前对话是否已经解除父子关系。

**会话菜单**（任意对话的 `⋯`）—— 多一条 **删除会话**（垃圾桶图标）。删除前会先备份，所以随时可恢复。

删一个会话分三步，顺序不能换：

1. **备份**到 `~/.dsh/session-guard-backup/`，校验字节数
2. **从 DSH 列表摘掉** —— 走官方归档通道 `workspaceRegistry.archiveSession(id)`，
   否则会出现「文件删了但列表还在」，给那个会话发消息直接 `ENOENT`
3. **物理删除**目录

如果删的正是你正在看的那个会话，插件会自动切到另一个会话——
因为主面板用引用计数持有会话，而服务层没有强制释放的接口，
只能靠切换让它自然释放。

**正在运行的会话删不掉**（DSH 会拒绝归档正在跑的会话），这是有意的：
强行停掉可能丢掉正在生成的内容。

**侧边栏图标区** —— 面板图标上方有一个「收起部分 ▼ / 展开全部 ▲」开关。收起不是全隐藏，而是**只显示前 N 个、其余滚动**。右键开关可以选 N（1–6，默认 4）；选的行数和收起状态都会记住，重启保持。

---

## 工具

### `dsh_session_lineage`

只读。报告会话总数、仍会被连带删除的真实对话分支、以及悬空的父引用。

```
会话总数: 275
真实对话 fork（删除时会被连带带走）: 0
悬空引用（父已不存在）: 0
```

### `dsh_detach_sessions`

默认预演；传 `confirm=true` 才真正写入。每个被改动的文件都会在其会话目录下留一份备份，写完再校验一遍。

```
{ "sessionId": "session-abc12345" }   # 只处理一个
{ "all": true }                       # 处理全部真实对话分支
{ "confirm": true }                   # 真正写入
```

---

## HTTP 接口

浏览器侧通过 `/session-guard` 访问这些端点：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/state` | 开关状态、统计、最近记录、孤儿子代理 |
| GET | `/audit` | 读不出来的会话，附原因 |
| GET | `/restorable` | 备份里有、当前已经不存在的会话 |
| GET | `/backups` | 备份列表 —— `filter=alive\|deleted`、`limit`、`offset` |
| POST | `/toggle` | `{ enabled: boolean }` |
| POST | `/detach` | `{ sessionId? }` |
| POST | `/delete` | `{ sessionId \| sessionIds, confirm?, cascade? }` —— 不传 `confirm: true` 就是预演 |
| POST | `/backup` | 立即做一次增量备份 |
| POST | `/restore` | `{ sessionId, overwrite? }` |
| POST | `/drop-backup` | `{ sessionId }` |
| POST | `/drop-backups` | `{ sessionIds }` |
| POST | `/prune-backups` | 按保留期清理备份 |
| POST | `/settings` | `{ retentionDays }` |
| POST | `/clear` | 清空解除记录 |
| GET | `/diag` | 回读浏览器上报的删除决策轨迹（最近 20 条）|
| POST | `/diag` | 浏览器上报决策轨迹 —— 排查「删了界面没反应」用 |

---

## 写入是怎么保证安全的

清空 `parentSession` 意味着要重写 zstd 多帧文件的第 0 帧，而此时 DSH 可能正在往后追加。规则如下：

1. **正经解析帧结构。** 不是"找第二个魔数"—— 读帧头、走 block 到 `lastBlock`、跳过 checksum。DSH 在 `scanZstdFrames` 里做的也是这件事。
2. **与 DSH 的压缩参数一致。** DSH 写帧时带 `ZSTD_c_checksumFlag: 1`，替换帧也带。
3. **检测并发追加。** 写之前把整个文件重读一遍做比对。快照之后有任何变化，说明有别的写入者，直接放弃，绝不硬写。
4. **写完校验。** 事件区字节必须与写前快照完全一致。不一致就用几秒前那份备份还原。

返回状态：`detached` · `already` · `busy` · `failed` · `conflict` · `planned`。

---

## 范围与限制

- **只处理真实对话。** `origin === "subagent"` 的会话会被跳过。
- **删父话题时父话题照样会被删。** 本插件去掉的是*连带*，不是删除本身。
- **只清 `parentSession`。** fork 历史、事件日志、标题都不动。
- **备份是副本，不是版本历史。** 每个会话 id 一份，会话变了就覆盖。
- **恢复需要项目目录。** 备份里记了会话来自哪个项目；没有它就拒绝猜路径。

---

## 许可

MIT。见 [LICENSE](./LICENSE)。
