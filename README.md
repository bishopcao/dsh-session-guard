# dsh-session-guard · 会话守护

阻止 DSH 删除父话题时连带删除子会话，并提供增量备份、误删恢复、数据体检、孤儿清理和一键安全删除等能力。

License: MIT · Tested on DSH `0.2.1-rc.2`

---

## 能力一览

### 会话保护

- 新分支一建立就自动断开父子关系，删父话题不再连带删除子对话
- 装之前就存在的历史分支，启动时自动扫一遍补齐
- 子代理会话不动（它们的父子关系是运行时正常结构）

### 备份与恢复

- 自动增量备份所有会话到 `~/.dsh/session-guard-backup/`
- 首次全量，之后只复制变过的文件（真实环境：首次 275 个会话 / 549 MB / 573 ms，之后 38 ms）
- 被误删的会话可逐字节还原
- 备份保留期可设（默认 30 天，`0` = 永不清理）
- 只清理「会话已不存在」的备份，活着的会话不会因过期被删

### 删除会话

- 会话 `⋯` 菜单里多一条「删除会话」
- 流程：先备份 → 从列表摘掉 → 再物理删除，删错可恢复
- 支持级联：连子代理和 fork 后代一起删
- 正在运行的会话删不掉，避免丢失正在生成的内容
- 删的若是当前正在看的会话，主面板会自动切走

### 数据体检

- 列出读不出来的会话文件并附原因：帧头损坏、空目录、id 不匹配、项目目录打不开等
- 把「备份列表少了一个」变成「能说清为什么少」

### 孤儿子代理清理

- 父会话已不在、却还占着磁盘的子代理会被单独列出
- 支持一键清理，清理前自动备份

### 侧边栏图标区折叠

- 图标太多挤占工作区时，可只显示前 N 个、其余滚动
- N 可选 1–6（默认 4），收起状态和行数都会记住

### 给 agent 的工具

- `dsh_session_lineage` —— 只读，查看父子链、风险和悬空引用
- `dsh_detach_sessions` —— 手动解除，默认预演，传 `confirm: true` 才写入

---

## 解决什么问题

DSH 支持从一条对话分出新分支（`Ctrl+Alt+F`）。子会话会在 header 里记下 `parentSession`，而归档插件把每个子会话都当成「可丢弃的后代」：删掉父话题，整族一起 `rmSync`，直接落盘、不进回收站。

于是「清理一下已归档话题」这一下点击，就可能无声地毁掉你从没归档过的对话。

本插件从两头堵：一边让父子关系压根不产生，一边留一份备份兜底。

---

## 安装

```bash
dsh plugin --profile desktop add dsh-session-guard
```

或直接写进 `~/.dsh/profiles/<profile>/package.json`：

```json
{
  "dependencies": { "dsh-session-guard": "1.0.7" },
  "dsh": { "profile": { "bundles": ["dsh-session-guard"] } }
}
```

装完重启 DSH。

### 配置

`cordis.patch.yml`，三项都有运行时开关：

```yaml
- insert:
    - id: session-guard
      name: dsh-session-guard
      config:
        autoDetachOnMount: true    # 启动时解除历史分叉
        backupOnMount: true        # 启动时增量备份
        backupRetentionDays: 30    # 备份保留天数，0 = 永不清理
```

---

## 怎么用

### 界面上会多出这些

**侧边栏盾牌图标** —— 点开在中央区域显示完整面板：

- 自动独立开关
- 最近的解除记录（会话没了会自动清掉），带分页
- 数据体检
- 孤儿子代理清理
- 备份管理：现存 / 已删除两个标签页、分页、每页条数、恢复、删除
- 删除会话（会连带删除子代理和 fork 后代）

**插件卡片** —— 「插件」页里的 `dsh-session-guard`，功能同上。

**会话头部小徽标** —— 显示当前对话是否已解除父子关系。

**会话菜单** —— 任意对话的 `⋯` 里多一条「删除会话」（垃圾桶图标）。

### 删除一个会话分三步

顺序不能换：

1. **备份**到 `~/.dsh/session-guard-backup/`，校验字节数
2. **从 DSH 列表摘掉** —— 走官方归档通道 `workspaceRegistry.archiveSession(id)`，
   否则会出现「文件删了但列表还在」，给那个会话发消息直接 `ENOENT`
3. **物理删除**目录

归档失败就中止删除：宁可删不掉，也不留下 Host 与磁盘不一致的状态。

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

```json
{ "sessionId": "session-abc12345" }   // 只处理一个
{ "all": true }                       // 处理全部真实对话分支
{ "confirm": true }                   // 真正写入
```

返回状态：`detached` · `already` · `busy` · `failed` · `conflict` · `planned`。

---

## HTTP 接口

浏览器侧通过 `/session-guard` 前缀访问：

**只读（GET）**

- `GET /state` —— 开关状态、统计、最近记录、孤儿子代理
- `GET /audit` —— 读不出来的会话，附原因
- `GET /restorable` —— 备份里有、当前已经不存在的会话
- `GET /backups` —— 备份列表，支持 `filter=alive|deleted`、`limit`、`offset`
- `GET /diag` —— 回读浏览器上报的删除决策轨迹（最近 20 条）

**写入（POST）**

- `POST /toggle` —— `{ enabled: boolean }`
- `POST /detach` —— `{ sessionId? }`
- `POST /delete` —— `{ sessionId | sessionIds, confirm?, cascade? }`，不传 `confirm: true` 就是预演
- `POST /backup` —— 立即做一次增量备份
- `POST /restore` —— `{ sessionId, overwrite? }`
- `POST /drop-backup` —— `{ sessionId }`
- `POST /drop-backups` —— `{ sessionIds }`
- `POST /prune-backups` —— 按保留期清理备份
- `POST /settings` —— `{ retentionDays }`
- `POST /clear` —— 清空解除记录
- `POST /diag` —— 浏览器上报决策轨迹（排查「删了界面没反应」用）

这些接口没有对外认证 —— 它们挂在 DSH 自己的 web server 上，靠 DSH 那层的访问控制。**不要把它暴露到公网。**

---

## 兼容性

**实测版本：DSH `0.2.1-rc.2`，Node `^22.19.0` / `>=24.0.0`。**

`package.json` 里的 `engines.dsh: ">=0.2.1-rc.2"` 是**实际跑过的版本**，不是验证过的下限。更旧的版本也许能用，但没测过。

DSH 插件的扩展点会随版本出现、消失或改 props。本插件用到 5 个客户端插槽，**每一个都在各自的 `try` 里独立注册**：

- `plugins.bundle.config` 缺失 → 没有插件卡片
- `conversation.session.header.utilities` 缺失 → 没有会话头部徽标
- `sidebar.workspaces.session.menu.item` 缺失 → 会话菜单里没有「删除会话」
- `sidebar.panellist` / `main` 缺失 → 没有侧边栏面板

少一个插槽 = 少一块界面，**不会拖垮整个插件**——这一点是踩过坑的：最早版本没有逐插槽隔离，某个版本少了一个 slot，整个插件在加载时直接抛异常，而 Cordis 会把这个异常吞掉，只看到插件「没装成功」、所有接口 404。

Host 侧（两个工具、`/session-guard/*` 接口、备份和解除逻辑）不受客户端插槽影响，缺插槽时照常工作。

会话文件布局是 `sessions/<项目>/<会话id>/session.v4.jsonl.zstd`。文件名里的 `v4` 是格式版本；如果某个 DSH 版本把它改了，`scanSessions()` 会把那些会话列为「读不出来」（进数据体检），而不是静默出错。

---

## 写入是怎么保证安全的

清空 `parentSession` 意味着要重写 zstd 多帧文件的第 0 帧，而此时 DSH 可能正在往后追加。规则如下：

1. **正经解析帧结构。** 不是「找第二个魔数」—— 读帧头、走 block 到 `lastBlock`、跳过 checksum。DSH 在 `scanZstdFrames` 里做的也是这件事。
2. **与 DSH 的压缩参数一致。** DSH 写帧时带 `ZSTD_c_checksumFlag: 1`，替换帧也带。
3. **检测并发追加。** 写之前把整个文件重读一遍做比对。快照之后有任何变化，说明有别的写入者，直接放弃，绝不硬写。
4. **写完校验。** 事件区字节必须与写前快照完全一致。不一致就用几秒前那份备份还原。

---

## 范围与限制

- **只处理真实对话。** `origin === "subagent"` 的会话会被跳过。
- **删父话题时父话题照样会被删。** 本插件去掉的是*连带*，不是删除本身。
- **只清 `parentSession`。** fork 历史、事件日志、标题都不动。
- **备份是副本，不是版本历史。** 每个会话 id 一份，会话变了就覆盖。
- **恢复需要项目目录。** 备份里记了会话来自哪个项目；没有它就拒绝猜路径。
- **接口不对外认证。** 不要暴露到公网。

---

## 许可

MIT。见 [LICENSE](./LICENSE)。
