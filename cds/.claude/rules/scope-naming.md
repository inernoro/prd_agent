# CDS 作用域命名规范（Scope Naming）

> 任何涉及"配置/设置"的代码、UI 文案、API 路径、commit message、文档，**必须明确"系统级"还是"项目级"**。
> 这条规则诞生于 2026-04-27 用户连续三次反馈"系统设置 / 项目设置混在一起"之后，旨在杜绝再次出现。

---

## 0. 最高原则：永远区分"系统级 vs 项目级"

CDS 有两个**不可混用**的作用域：

- **系统级（System）**：影响整个 CDS 实例，与任何具体 project 无关  
  例：CDS 自更新、集群拓扑、登录账号、GitHub App、自身存储模式、镜像加速、跨项目公共环境变量
- **项目级（Project）**：属于某一个具体 project，必须带 `projectId` 标识  
  例：项目环境变量、构建配置、基础设施、路由规则、PR 评论模板、删除项目

**判定标准**（写代码 / 文案 / API 时三秒内决定）：

| 这个东西如果创建第二个项目还有意义吗 | 答案 | 那它属于 |
|---|---|---|
| 自更新 CDS | 不需要重复，全局只一份 | 系统级 |
| 集群拓扑 | 同上 | 系统级 |
| GitHub App webhook secret | 同上 | 系统级 |
| 镜像加速开关 | 同上 | 系统级 |
| 项目 X 的 `JWT_SECRET` | 项目 Y 应该有自己的 | **项目级** |
| 预览模式（simple/port/multi） | 项目 X 选 simple、项目 Y 选 port 完全合理 | **项目级** |
| PR 评论模板 | 项目 X 仓库和项目 Y 仓库的 PR 评论格式可以不同 | **项目级** |

---

## 1. 唯一术语表（强制）

CDS 所有 UI 文案、API label、文档、commit message **只允许**用下面这 4 个词，禁止裸用 / 同义混用：

| 唯一术语 | 含义 | 实体位置 |
|---|---|---|
| **CDS 系统设置** | 整个 CDS 实例的设置入口 | `cds/web/cds-settings.html` |
| **CDS 全局变量** | 所有项目共享的 `_global.customEnv`（系统设置的一部分） | 系统设置页里的一个 tab |
| **项目设置** | 单个项目的设置入口 | `cds/web/settings.html?project=<id>` |
| **项目环境变量** | 单项目独占的 `project.customEnv` | 项目设置页里的一个 tab + 分支页弹窗 |

### 禁用清单（grep 全部替换）

| 禁用词 | 改为 |
|---|---|
| 裸"设置"（不带前缀） | "CDS 系统设置" 或 "项目设置"，明示是哪个 |
| "用户设置" | 不存在该概念。账号操作叫"账号"或"个人账号" |
| "全局设置" | "CDS 系统设置" |
| "CDS 全局设置" | "CDS 系统设置" |
| "环境变量"（不指明 scope） | "CDS 全局变量" 或 "项目环境变量" |

---

## 2. URL / 路由规范

| 路径 | 作用域 | 必须参数 | 例 |
|---|---|---|---|
| `/cds-settings.html` | 系统级 | 无 | `https://cds.miduo.org/cds-settings.html` |
| `/settings.html` | **项目级** | `?project=<id>`，否则跳 `/project-list` | `/settings.html?project=prd-agent` |
| `/index.html`（分支列表） | 项目级 | `?project=<id>` | `/index.html?project=prd-agent` |
| `/project-list.html` | 系统级（项目入口） | 无 | `/project-list` |

`settings.html` 不带 `?project=` 进入时**必须 redirect 到 `/project-list`**，不允许继续渲染。

---

## 3. API 路径规范

### 系统级（不带项目语境）

```
GET  /api/cds-system/...           # 推荐前缀
POST /api/self-update              # 历史路径，保留
POST /api/factory-reset            # 历史路径，保留
GET  /api/env?scope=_global        # 跨项目公共变量
POST /api/cluster/...              # 集群操作
GET  /api/github/app               # GitHub App 配置
```

### 项目级（必须带 projectId）

```
GET  /api/projects/:id                    # 项目元数据
GET  /api/projects/:id/agent-keys         # 项目 Agent Keys
PUT  /api/projects/:id/preview-mode       # 项目预览模式（per-project，新）
PUT  /api/projects/:id/comment-template   # 项目 PR 评论模板（per-project，新）
GET  /api/env?scope=<projectId>           # 项目环境变量
```

历史上无项目语境的 `/api/preview-mode`、`/api/comment-template` 已 deprecated，保留兼容期 + 启动时 console.warn。

新增 API 时**必须**判断作用域：

- 系统级 → 走 `/api/cds-system/*` 或顶级
- 项目级 → 走 `/api/projects/:id/*`，**严禁**用 `?project=` query 参数（语义不直观）

---

## 4. UI 入口规范

### 系统级入口（必须显眼）

- `project-list.html` 右上角 ⚙ 按钮 → 文案 "**CDS 系统设置**" → `/cds-settings.html`
- `index.html`（分支页）右上角 ⚙ 菜单 → 底部一个分隔区 + "**CDS 系统设置**" 链接

### 项目级入口

- `index.html` 面包屑 → "项目名 / 设置" → `/settings.html?project=<id>`
- `index.html` ⚙ 菜单上半部分 → "项目设置" + 项目级模态（构建配置 / 项目环境变量 / 基础设施 / 路由规则）
- `index.html` 拓扑视图左栏图标 → tooltip "**项目设置**"（不再是裸"设置"）

### 禁止的入口模式

- 在 user popover / 用户菜单里放任何"设置" —— 用户菜单只放账号操作（登录/登出/账号信息）
- 在系统级菜单里塞项目级配置项（反之亦然）
- 用 emoji ⚙ 之外的图标做"设置"入口

---

## 5. 状态字段规范

`cds/src/types.ts` 的 SSOT：

| 字段位置 | 含义 | 例子 |
|---|---|---|
| `CdsState.xxx`（顶层） | 系统级 | `customEnv._global` / `infraServices` / `executors` / `globalAgentKeys` |
| `Project.xxx`（每项目独立） | 项目级 | `customEnv` / `previewMode` / `commentTemplate` / `defaultBranch` / `githubRepoFullName` |

新增字段时优先放 `Project`（multi-tenancy 友好），除非明确**必须全实例共享**才放 `CdsState`。

历史已废弃字段（保留 fallback）：

- `CdsState.previewMode` → 用 `Project.previewMode`
- `CdsState.commentTemplate` → 用 `Project.commentTemplate`
- `CdsState.defaultBranch` → 用 `getDefaultBranchFor(projectId)`

---

## 6. 提交信息 / 文档规范

commit / PR 描述里写"修复设置"是模糊的，必须明示：

```
fix(cds): 修复 [项目设置] 中评论模板保存按钮卡顿
feat(cds): [CDS 系统设置] 新增孤儿容器清理 tab
```

---

## 7. 自动化检查（CI 友好）

未来可在 PR check 里加一个 grep 守卫：

```bash
# CI 检查脚本（暂未实施，作规划）
git diff --name-only origin/main...HEAD \
  | xargs grep -nE '"用户设置"|"全局设置"|"CDS 全局设置"' 2>/dev/null \
  && { echo "禁用词检测命中，参见 .claude/rules/scope-naming.md §1"; exit 1; } \
  || echo "scope-naming OK"
```

---

## 8. 历史背景

- 2026-04-27 用户连续三次反馈"系统设置 / 项目设置混在一起"
- 第一次：dashboard 环境变量弹窗里全局 vs 项目混淆
- 第二次：`settings.html` 看似系统设置实为项目级 → 404
- 第三次：发现 user popover 里有"用户设置"链接但实际跳项目级页

每次都因为缺乏强命名规范导致同一类问题再犯。本规则置顶意在**用文档锁死语义**，所有人（人类 + AI）写代码时都按这个 SSOT。

## 相关

- `cds/CLAUDE.md` 顶部相关规则速查表会引用本文件
- `cds/src/config/known-env-keys.ts` —— CDS 内置变量字典（环境变量层面的 SSOT）
- 主 `CLAUDE.md` §6 LLM 可见性 / 通用强制规则
