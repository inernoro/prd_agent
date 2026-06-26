# CDS 数据迁移 · 设计

> **版本**：v1.0 | **日期**：2026-04-06 | **状态**：已落地
>
> CDS 设置面板中的数据迁移功能。当前支持 MongoDB，架构可扩展至其他数据库类型。

## 一、管理摘要

- **解决什么问题**：开发者需要在不同 MongoDB 实例间迁移数据（如生产→测试、主库→灰度），当前只能手动执行 `mongodump/mongorestore` 命令，操作繁琐且缺乏进度反馈
- **方案概述**：在 CDS Dashboard 设置菜单中新增"数据迁移"功能，提供左右双面板配置源/目标数据库，支持全库或指定集合迁移，SSE 实时进度推送，SSH 隧道穿透
- **业务价值**：一键迁移数据，零命令行操作，进度实时可见，支持集合级精确控制
- **影响范围**：仅 CDS 模块内部（`cds/src/` + `cds/web/`），不影响主项目代码
- **预计风险**：低 — 使用成熟的 `mongodump/mongorestore` 工具，迁移过程可重复执行

---

## 二、产品定位

### 目标用户

开发者、运维人员 — 需要在 CDS 管理的多个环境间同步数据库数据。

### 核心场景

| 场景 | 操作路径 |
|------|---------|
| 生产数据同步到测试环境 | 设置 → 数据迁移 → 新建 → 选源库 → 选目标 → 执行 |
| 迁移指定集合 | 同上，选库后勾选需要的集合 |
| 重复执行上次迁移 | 任务列表 → 点击"执行" |
| 基于历史任务创建新任务 | 任务列表 → 点击"克隆" → 修改参数 → 执行 |

---

## 三、用户交互流程

### 新建迁移的交互设计原则

**"能选就不填"** — 所有可自动获取的信息都用下拉框或自动填充，最小化用户手动输入。

```
打开新建迁移面板
├── 源数据库
│   ├── 选择连接类型: "本机 MongoDB" / "远程 MongoDB"
│   ├── 自动连接并加载数据库列表 (下拉框)
│   ├── 选择数据库 → 自动加载集合列表 (复选框)
│   └── 可选: 勾选特定集合 (不选=全部迁移)
│
├── 自动行为
│   ├── 目标数据库名 ← 自动同步为源库同名
│   └── 任务名称 ← 自动生成 "本机/prdagent → 远程"
│
├── 目标数据库
│   ├── 选择连接类型 → 自动加载数据库列表
│   └── 数据库名已自动填充，可修改
│
└── 点击 "创建并执行"
```

### 连接失败降级

当自动加载数据库列表失败时（如远程不可达），下拉框自动切换为文本输入框，允许手动填写数据库名。

---

## 四、核心决策

| 决策 | 选项 | 结论 | 理由 |
|------|------|------|------|
| 迁移工具 | 自研 vs mongodump/mongorestore | mongodump/mongorestore | 成熟稳定，支持全部 MongoDB 版本，无需重新实现复杂的 BSON 序列化 |
| 进度推送 | 轮询 vs SSE | SSE | CDS 已有 SSE 基础设施，实时性好，无需客户端轮询 |
| 集合迁移策略 | 一次 dump 全库再过滤 vs 逐集合 dump | 逐集合 dump | 精确控制进度百分比，单集合失败不影响其他集合 |
| 状态持久化 | 数据库 vs state.json | state.json | CDS 所有状态统一存储在 state.json，保持一致性 |
| 工具安装 | 要求预装 vs 自动安装 | 自动安装 | 减少用户配置成本，支持多平台（Debian/Alpine/RHEL + 二进制兜底） |

---

## 五、整体架构

```
┌─────────────────────────────────────────────────────────────┐
│  CDS Dashboard (浏览器)                                      │
│                                                              │
│  设置 → 数据迁移                                              │
│  ┌─────────────────┐     ┌─────────────────┐                │
│  │  📤 源数据库     │ ──→ │  📥 目标数据库    │                │
│  │  下拉选库        │     │  自动同步库名     │                │
│  │  勾选集合        │     │  下拉选库         │                │
│  └────────┬────────┘     └────────┬────────┘                │
│           │                       │                          │
│           ▼                       ▼                          │
│  ┌────────────────────────────────────────────┐              │
│  │  SSE 进度流 (event: progress / done / error) │              │
│  │  [████████████░░░░░░] 67% 正在导入 groups    │              │
│  └────────────────────────────────────────────┘              │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP API
┌──────────────────────────┼──────────────────────────────────┐
│  CDS Server (Node.js)    │                                   │
│                          ▼                                   │
│  routes/branches.ts                                          │
│  ├── POST /data-migrations              创建任务              │
│  ├── POST /data-migrations/:id/execute  执行迁移 (SSE)       │
│  ├── POST /data-migrations/list-databases   数据库列表       │
│  ├── POST /data-migrations/list-collections 集合列表         │
│  ├── POST /data-migrations/test-connection  连接测试         │
│  ├── POST /data-migrations/check-tools      工具检查         │
│  ├── POST /data-migrations/install-tools    工具安装 (SSE)   │
│  ├── GET  /data-migrations              任务列表              │
│  ├── GET  /data-migrations/:id/log      迁移日志              │
│  └── DELETE /data-migrations/:id        删除任务              │
│                                                              │
│  ┌──────────────────────────────────────┐                    │
│  │  shell.exec()                        │                    │
│  │  ├── mongodump  (导出 → /tmp/...)    │                    │
│  │  ├── mongorestore (导入 → 目标库)    │                    │
│  │  ├── mongosh (list-databases/colls)  │                    │
│  │  └── ssh -f -N -L (SSH 隧道)         │                    │
│  └──────────────────────────────────────┘                    │
│                                                              │
│  state.json → dataMigrations[]                               │
└──────────────────────────────────────────────────────────────┘
```

---

## 六、数据设计

### DataMigration 实体

存储在 `state.json` 的 `dataMigrations` 数组中。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 唯一 ID，格式 `mig-{timestamp36}` |
| `name` | string | 任务名称（自动生成或用户输入） |
| `dbType` | `'mongodb'` | 数据库类型（预留扩展） |
| `source` | MongoConnectionConfig | 源连接配置 |
| `target` | MongoConnectionConfig | 目标连接配置 |
| `collections` | string[] \| undefined | 指定集合（undefined=全库迁移） |
| `status` | enum | `pending` / `running` / `completed` / `failed` |
| `progress` | number | 0-100 进度百分比 |
| `progressMessage` | string | 当前步骤描述 |
| `errorMessage` | string | 失败原因 |
| `createdAt` | ISO string | 创建时间 |
| `startedAt` | ISO string | 开始执行时间 |
| `finishedAt` | ISO string | 完成时间 |
| `log` | string | 迁移过程日志 |

### MongoConnectionConfig

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `'local'` \| `'remote'` | local=CDS 基础设施 MongoDB |
| `host` | string | 主机地址 |
| `port` | number | 端口 |
| `database` | string | 数据库名（空=全部） |
| `username` | string | 认证用户名 |
| `password` | string | 认证密码 |
| `authDatabase` | string | 认证库（默认 admin） |
| `sshTunnel` | SshTunnelConfig | SSH 隧道配置 |

### SshTunnelConfig

| 字段 | 类型 | 说明 |
|------|------|------|
| `enabled` | boolean | 是否启用 |
| `host` | string | SSH 跳板机地址 |
| `port` | number | SSH 端口（默认 22） |
| `username` | string | SSH 用户名 |
| `privateKeyPath` | string | 私钥路径 |

---

## 七、接口设计

### 迁移执行流程（SSE）

```
POST /api/data-migrations/:id/execute

客户端 ←── SSE 事件流:
  event: progress  data: {"progress": 5,  "message": "正在检查迁移工具..."}
  event: progress  data: {"progress": 20, "message": "正在导出 users (1/3)..."}
  event: progress  data: {"progress": 32, "message": "正在导入 users (1/3)..."}
  event: progress  data: {"progress": 43, "message": "正在导出 groups (2/3)..."}
  ...
  event: progress  data: {"progress": 95, "message": "正在清理临时文件..."}
  event: progress  data: {"progress": 100, "message": "迁移完成！"}
  event: done      data: {"message": "迁移完成"}
```

失败时：
```
  event: error     data: {"message": "mongodump 失败: connection refused"}
```

### 进度计算

| 模式 | 进度分配 |
|------|---------|
| 全库迁移 | 0-5% 工具检查 → 20-50% 导出 → 55-85% 导入 → 95% 清理 → 100% |
| N个集合 | 0-5% 工具检查 → 每个集合占 `70/2N` %（导出+导入各一半）→ 95% 清理 → 100% |

### 数据库/集合列表

```
POST /api/data-migrations/list-databases
Body: { connection: MongoConnectionConfig }
Response: { databases: [{ name: "prdagent", sizeOnDisk: 118431744 }, ...] }

POST /api/data-migrations/list-collections
Body: { connection: MongoConnectionConfig }  // 必须包含 database
Response: { collections: [{ name: "users", count: 64 }, ...] }
```

---

## 八、迁移工具自动安装

CDS 服务器上可能没有 `mongodump/mongorestore`，支持自动检测和安装。

### 安装策略（按优先级）

| 平台 | 方式 | 命令 |
|------|------|------|
| Debian/Ubuntu | apt-get | `apt-get install mongodb-database-tools` |
| RHEL/CentOS | yum/dnf | `yum install mongodb-database-tools` |
| 兜底方案 1 | deb 解压 | 从 fastdl.mongodb.org 下载 deb，`dpkg -x` 提取二进制 |
| 兜底方案 2 | tarball | 从 fastdl.mongodb.org 下载 tgz，解压到 `/usr/local/bin/` |

安装过程通过 SSE 推送进度。

---

## 九、SSH 隧道

当源或目标 MongoDB 在内网/防火墙后时，通过 SSH 隧道穿透。

```
CDS Server  ──SSH──>  跳板机  ──────>  MongoDB
   :27100 (本地端口)          :27017 (远程端口)

ssh -f -N -L 27100:mongo-host:27017 user@jump-host -p 22
```

- 源隧道端口范围：`27100-27199`（随机分配）
- 目标隧道端口范围：`27200-27299`（随机分配）
- 迁移完成后自动 `pkill` 清理隧道进程

---

## 十、前端 UI 结构

### 设置菜单入口

CDS Dashboard 右上角设置菜单 → "数据迁移" 选项。

### 任务列表视图

每个任务卡片展示：

```
┌─────────────────────────────────────────────────┐
│ ● 已完成    本机/prdagent → 远程               7分钟前 │
│                                                  │
│ [本机 MongoDB/prdagent] → [172.17.0.1:10195/copy]│
│                                                  │
│ 📦 3 个集合  ⏱ 0.4秒                            │
│                                                  │
│ [▶ 执行] [⧉ 克隆] [📋 日志] [删除]              │
└─────────────────────────────────────────────────┘
```

### 新建迁移视图

左右双面板布局：

```
┌──────────────────┐     ┌──────────────────┐
│ 📤 源数据库       │     │ 📥 目标数据库     │
│                  │     │                  │
│ [本机 MongoDB ▼] │  →  │ [远程 MongoDB ▼] │
│ [prdagent    ▼] │     │ [prdagent    ▼]  │ ← 自动同步
│                  │     │                  │
│ ☑ users    64   │     │ 127.0.0.1:27017  │
│ ☐ groups   12   │     │ admin / ••••     │
│ ☑ sessions 89   │     │                  │
│ ☐ messages 1.2k │     │ □ SSH 隧道       │
│ □ SSH 隧道       │     │                  │
│ ✓ 已连接 · 4 库  │     │ ✓ 已连接 · 3 库   │
└──────────────────┘     └──────────────────┘

[▶ 创建并执行]  [💾 仅保存]  [取消]
```

---

## 十一、扩展性

### 新增数据库类型

架构预留了 `dbType` 字段。新增数据库类型需要：

1. 在 `types.ts` 中扩展 `dbType` 联合类型（如 `'mongodb' | 'redis' | 'postgres'`）
2. 在 `routes/branches.ts` 的 execute 路由中增加对应的 dump/restore 逻辑分支
3. 在前端 `buildConnectionForm` 中增加对应的配置字段

当前实现中，连接配置 `MongoConnectionConfig` 是 MongoDB 专用的。未来可抽象为 `ConnectionConfig` 联合类型。

---

## 十二、关联文档

| 文档 | 关系 |
|------|------|
| `doc/design.cds.md` | CDS 主架构文档（本功能是其子模块） |
| `.claude/skills/cds-deploy-pipeline` | CDS 部署流水线技能（用于测试验证） |
| `changelogs/2026-03-31_data-migration.md` | 变更记录碎片 |
