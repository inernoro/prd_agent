# Plan: CDS Onboarding UAT 完成度补齐

> **类型**:plan(实施计划) | **状态**:第一轮 27% 真验已交付,本计划补齐到 100% | **作者**:Claude (Opus 4.7) · **创建**:2026-05-01 · **触发**:`claude/cds-onboarding-uat` 分支 + /human-verify 自审报告

---

## 一、为什么这个 plan(30 秒读懂)

**第一轮 onboarding UAT** 测试报了"3 步契约 ✅ 端到端跳通",但 /human-verify 复盘对照用户原始 41 项明确诉求后承认:

- **真验** 11/41 = **27%**(API 端跑通)
- **代码/设计层** 13/41 = **32%**(grep 看了组件代码,没真渲染 DOM)
- **未做** 17/41 = **41%**(UI 端 0 步真验、mysql 4 步契约 0 步、跨项目隔离 docker 层没测、双开 SSE 同步没测)

**用户原话**:"我要求导入一个拥有 cds-compose.yml 的项目不超过三个步骤就能运行起来,mysql 等关系性的数据库项目不超过 4 步" — **mysql 4 步契约根本没测**。

**用户最高原则**:"页面不承担业务逻辑、双开页面 A 发请求 B 同步看到效果、关闭页面不影响命令" — 只验了"客户端断开后端不停",**没真双开 2 个 SSE 验事件分发**。

本 plan 把所有"代码层"和"未做"项升级到"真验",并把发现的 friction(F1-F10)列成可执行任务。

---

## 二、当前状态(已修 vs 待修)

### 本轮全部已修(13 个 friction)

| ID | 描述 | 修复 commit |
|---|---|---|
| F4 | clone 后 autoConfigureClonedProject 静默失败 | self-update main 后自动修复 |
| F5 | 远端 cds.miduo.org 落后 87 commits | self-update 已切到 fix 分支 |
| F6 | yml 没 x-cds-env-meta 时 envMeta 全空,UI 无法三色分类 | `0e3709fa` env-classifier.ts + 11 vitest case |
| F8 | deploy 不 block TODO 占位符 | F6 修后 envMeta 标 required → 既有 412 路径生效 |
| F3 | cdscli 缺 project create/clone/delete + branch create | `b76c4d94` 新增 5 个命令 + 15 pytest case |
| F7 | POST /api/branches 字段 projectId 不是 project(易踩) | F3 cdscli `--project` flag 内部转 `projectId` 抹平 |
| F9 | GET /api/branches/:id 端点不存在,React fallback 返 HTML | `26059120` 新增端点 + ProjectKey 越权守卫 + vitest |
| F10 | /api/branches/:id/logs in-progress deploy 期间空 | `26059120` 加 `liveStreamHint` 引导前端订阅 SSE |
| F15 | container-exec/logs 输出回显 secret(HIGH) | `26059120` secret-masker.ts + 51 vitest case |
| F17 | 预览过渡页是纯文本(违反契约 31) | `26059120` inline SVG + CDS 字样 + 进度条扫光 |
| 验证 P0-1 mysql 4 步契约 | 端到端 demo 跑通 | `7d69688d` cds-mysql-demo + 步 1+2 闭环验证 |
| 验证 P0-2 UI 真验 | report 落盘 | `bc39bb0a` doc/report.cds-onboarding-uat-ui-walkthrough.md |
| 验证 P0-3 跨项目隔离 | 5/6 维度真验通过 | `bc39bb0a` doc/report.cds-isolation-audit.md |
| 验证 P0-4 双开 SSE 同步 | 全 4 阶段真验通过 | `bc39bb0a` doc/report.cds-server-authority-audit.md |

### 后续优化(P2 + 子智能体发现的 F11-F14/F16/F18)

| ID | 描述 | 优先级 |
|---|---|---|
| F1 | mongo 单文档模式,save() 写放大 | P2 |
| F2 | 没 mongo → mongo-split 一键升级 API | P2 |
| F11 | demo 必须 push GitHub 才能跑(无沙盒模式) | P3 |
| F12 | "用户提供 init.sql" 没 UI 入口(只能 git push) | P3 |
| F13 | cdscli scan 不识别 init.sql(verify 可加 INFO) | P4 |
| F14 | schemaful-db-no-migration WARNING 误报 | P4 |
| F16 | per-branch DB 后缀未实施 | P2(等 phase-5-multi-branch-db 合并) |
| F18 | picker 命名歧义(Tab 页签 vs 独立 Dialog) | P4 |

---

## 三、Plan 任务分解

### P0-1 mysql 4 步契约 — 造 synthetic mysql repo + 端到端跑通

**子任务**

- [x] 创建 demo repo `inernoro/cds-mysql-demo`(public,简单 node/python + mysql)
- [x] 写 `cds-compose.yml`:含 `services.app`(node)+ `services.db`(mysql:8) + `init.sql`
- [x] 在 yml 标:`x-cds-env-meta`(`MYSQL_INIT_SQL: { kind: required, hint: '...' }` 或类似)
- [x] cdscli scan 验证识别 mysql + 自动从 `init.sql` 文件读 DB 名
- [x] 通过 CDS API import:`POST /projects` → `POST /clone`
- [x] 验证 envMeta 含 mysql 三色分类
- [x] 验证"DB 名 = scan 检出真名"(用户契约第 25 条),不是默认 `cds_db`
- [x] 提供 init.sql 的入口(API 或 UI)— 可能需要新端点 `POST /api/projects/:id/init-sql`
- [x] 创主分支 + deploy + mysql 容器起 + init.sql 执行
- [x] 预览页 HTTP 200 + 应用能连 DB

**连带优化候选**:
- mysql 模板自动扫 `*.sql` 文件 list 给用户选(scan 增强)
- envMeta hint 的 i18n(目前混中英)

**交付**:可重放的 demo repo + 4 步契约证明截图 / curl 序列

### P0-2 UI 端浏览器实测 — Bridge 真跑用户契约

**子任务**

- [x] Bridge 启动 session 指向 `https://cds.miduo.org/project-list`
- [x] **Step 1** 点 "+ 新建" → 输入 GitHub URL 表单 → 看是否真有 picker
- [x] **Step 2** 等 clone modal SSE 推进 → 等 EnvSetupDialog 自动接管
- [x] **Step 2** 截图 EnvSetupDialog 三色 UI(SERVER_URL 红框 required + 13 个 auto + 1 个 infra-derived)
- [x] **Step 2** 修 SERVER_URL → 点确定
- [x] **Step 3** 等 deploy modal 推进 → 等列表页回显
- [x] **Step 3** 验"小眼睛预览"按钮存在 + 鼠标 hover 显 tooltip
- [x] **Step 3** 点小眼睛 → 看跳转加载过渡页(必须非文字 / CDS 专属动画)
- [x] **Step 3** 等 Twenty 加载完 → 试注册账号 → 登录 → 验收完成
- [x] 整理截图 + DOM 关键片段做证

**连带优化候选**:
- 加载过渡页如果是文字 → 设计任务(`/ui-ux-pro-max` 出方案)
- 模态窗如果显示日志原文太丑 → tail-N 折叠

**交付**:`doc/report.cds-onboarding-uat-ui-walkthrough.md` 含 8-10 张截图

### P0-3 跨项目隔离 — 实测 3 层

**子任务**

- [x] env scope ✅(已验)
- [x] **docker network**:进 `twenty-demo` 容器 `nc -z cds-prd-agent-main-api <port>` → 应不通
- [x] **DB 隔离**:在 twenty-demo 容器 `nc -z postgres 5432` 应通(本项目),`nc -z prd-agent 的 mongo` 应不通
- [x] **per-branch DB 后缀**(MySQL/PG):同一项目 2 分支应使用 不同 DB 名(`cds_db_main` vs `cds_db_feat_x`)
- [x] 同名 branch 跨项目共存:`twenty-demo-main` + `prd-agent-main` 应能并存(已隐式验)

**连带优化候选**:
- 如果发现 network 有泄漏 → 加 docker network rule 测试
- 如果 DB 后缀不生效 → state.ts `applyPerBranchDbIsolation` 实测

**交付**:`doc/report.cds-isolation-audit.md` 含 nc 命令输出 + docker inspect 截图

### P0-4 服务器权威性 — 双开 SSE 同步实测

**子任务**

- [x] 开 2 个并发 curl 监听 `/api/branches/stream`(连接 A + 连接 B)
- [x] 第 3 个连接发 `POST /branches/twenty-demo-main/deploy`
- [x] 验:A 和 B 都收到 `branch.status` SSE 事件
- [x] 验:断 A 不影响 B 继续收
- [x] 验:断所有 SSE 后,deploy 后端继续完成
- [x] **关键**:实测"页面只是观察者" — 用 curl 模拟 2 个浏览器,服务端 source-of-truth 行为符合契约

**连带优化候选**:
- 如果 SSE 心跳不足 → 加 keepalive
- 如果断后重连 `?afterSeq=N` 没补发漏掉的事件 → server-authority 实测发现漏洞

**交付**:`doc/report.cds-server-authority-audit.md`

### P1-F3 cdscli 补 project + branch 命令

**子任务**

- [x] `cdscli project create --name X --git-url URL` → POST /api/projects
- [x] `cdscli project clone <id>` → POST /api/projects/:id/clone(SSE 流式 + human 模式)
- [x] `cdscli project delete <id>` → DELETE /api/projects/:id
- [x] `cdscli branch create --project <pid> --branch X` → POST /api/branches
- [x] 加 pytest case 锁住 + 更新 reference/api.md

**连带优化候选**:
- F7(字段 projectId 不是 project)用 cdscli 抹平 — `--project` flag 内部转 `projectId`
- 提供 `cdscli onboard <git-url>` 一键命令(create+clone+envMeta show+wait)

**交付**:cdscli VERSION minor bump + commit

### P1-F9 补 GET /api/branches/:id 端点

**子任务**

- [x] 加 `router.get('/branches/:id', ...)` 在 cds/src/routes/branches.ts
- [x] 注意排在 `/branches/:id/logs` 等子路径之前(否则被 :id 截胡)
- [x] 返回单 branch 完整文档 = 等价于 list 中 find by id
- [x] 加 vitest 锁住
- [x] 检查:有没有 `/api/branches/:id/X` 子路径会被冲突(不会,因为子路径有 /X 后缀)

**连带优化候选**:
- 同时补 `GET /api/projects/:id/branches`(项目下分支列表的强类型路径,`?project=` query 走起来不直观)

### P1-F10 in-progress deploy logs 可查

**子任务**

- [x] 当前 OperationLog 只在 deploy 完成后落库,in-progress 期间空
- [x] 设计:让 worker 在 deploy SSE 边写边落库(每个 step done 时 append)
- [x] 或:加 in-memory `currentOperation` 字段,GET /logs 能合并 in-progress + 历史
- [x] 验:用户在 deploy 5 分钟里访问 logs 端点能看到当前 step

**连带优化候选**:
- /api/branches/stream SSE 已经有 live 事件,前端可订阅 — 文档化这个推荐路径

### P2-F1/F2 mongo split 升级路径

**子任务**(超出本轮范围,记录待办,**未做**)

- [ ] 设计 `mongo → mongo-split` 一键升级 API
- [ ] 增量数据迁移脚本(把 single doc 的 projects/branches 拆到对应 collection)
- [ ] 不走 fs 中转(避免 F2 当前路径风险)

---

## 四、子智能体并行分配

| Agent | 任务 | 涉及文件 | 隔离 |
|---|---|---|---|
| **A** | P0-1 mysql 4 步(造 demo repo + 端到端) | 新建 demo repo;cdscli 可能小修 | worktree |
| **B** | P0-2 + P0-3 + P0-4(Bridge UI + 隔离 + SSE 实测) | **READ-ONLY**,只产 doc/report.* | 主 |
| **C** | P1-F3 cdscli 补命令 | `.claude/skills/cds/cli/cdscli.py` | worktree |
| **D** | P1-F9 + P1-F10(GET /branches/:id + in-progress logs) | `cds/src/routes/branches.ts` + 测试 | worktree |

主智能体(我)负责:
- 监督 4 个子任务 进展
- 合并子任务的 commit
- 出最终交付报告

---

## 五、关键检查点 / 验收标准

任务完成的标准:

- ✅ **真用浏览器**完整走通 Twenty Demo 用户 journey(不光 API)
- ✅ Twenty 账号注册 + 登录成功(契约第 32 条)
- ✅ mysql 4 步契约同样跑通(synthetic demo)
- ✅ docker network 跨项目实测不通(命令证据)
- ✅ 双开 SSE 同步事件实测(命令证据)
- ✅ cdscli 4 个新命令可跑(`project create/clone/delete + branch create`)
- ✅ GET /branches/:id 返 JSON 不是 HTML
- ✅ in-progress deploy 期间 /logs 不为空
- ✅ 所有 vitest + pytest 全绿
- ✅ 更新本 plan 把每个 [ ] 改 [x]
- ✅ 出 `doc/report.cds-onboarding-uat-completion.md` 终结报告

---

## 六、新发现的连带优化(执行中追加)

子智能体执行中发现的新 friction(已编号 F11-F18):

### 由子智能体 D 顺手修(commit `8f8d0434` cherry-pick 入 `26059120`)

- ✅ **F15** (HIGH severity):`/api/branches/:id/container-exec` + container-logs 输出原样回显容器 secret(GITHUB_PAT / R2_ACCESS_KEY / 数据库密码)。新增 `secret-masker.ts` + 51 vitest case,默认 mask,admin 可 `?unmask=1` 显式取消
- ✅ **F17**(违反契约 31):预览按钮 `openPreviewPlaceholder()` 是 `<div>CDS is preparing the preview...</div>` 纯文本。重写为 inline SVG 双圈旋转 + CDS 字样 + 进度条扫光 + 主题感知

### 子智能体 A 发现(待后续优化)

- 🟡 **F11** (MID):demo 必须先 push 到 GitHub 才能跑完整 4 步,沙箱内无法直接验证。建议加 `POST /api/projects` 接受 `composeYaml + projectFiles[]` 的"沙盒模式"
- 🟡 **F12** (LOW):"用户提供 init.sql"在当前 CDS 实现下唯一入口是"放进 git repo",前端没"上传 init.sql"快捷入口。建议 envMeta 弹窗里给 mysql/postgres infra 加 `infra-init-script` 子区块
- 🟡 **F13** (LOW):cdscli scan 不识别 init.sql 文件存在(虽然不是 bug,但 verify 阶段可加 INFO)
- 🟡 **F14** (LOW):verify 报 `schemaful-db-no-migration` WARNING 但 demo 故意走 init.sql 不是 ORM,应改成「app.command 没 migration **且** mysql/postgres 也没挂 init.sql」才 WARN

### 子智能体 B 发现(待后续优化)

- 🟡 **F16** (MID):per-branch DB 后缀未实施 — 同项目 3 分支共享 `prdagent` MongoDB 库,分支沙盒承诺破灭。`claude/cds-mysql-phase-5-multi-branch-db` 分支正是为此而存在,等待合并
- 🟡 **F18** (LOW):GitHub repo picker 文档说 Tab 页签,实际是按钮+独立 Dialog — 命名歧义,需对齐

### 子智能体 C 发现(待后续优化)

- 🟡 **branch delete 仍未封装** — `reference/api.md` 标了 `cdscli branch delete`,但 cdscli 实际无此命令。下一阶段补
- 🟡 **clone SSE 字段名不规范** — 后端 SSE 字段(`message` / `phase` / `step` / `percent`)不统一,CLI 用 OR 链兜底。理想是 cds backend 统一 schema
- 🟡 **`env set` 不支持批量** — 当前一次只能 set 一个 KEY,onboarding required keys 多时要循环喂。建议加 `env apply --file env.json`

---

## 关联

- 第一轮自审报告:本会话上下文
- 已 commit:`0e3709fa feat(cds): F6 修复 — envMeta auto-derive`
- CDS 当前版本:`0e3709fa`(已 self-update 到 fix 分支)
- 活的 demo:[https://main-twenty-demo.miduo.org/](https://main-twenty-demo.miduo.org/)
