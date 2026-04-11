---
name: acceptance-checklist
description: Generates a step-by-step user acceptance test (UAT) checklist that a real human executes by hand, with expected results and failure playbooks at every checkpoint. Covers CLI + Web UI scenarios, supports cold-start injection, and is checkbox-driven so the operator can mark progress. Trigger words: "/uat", "验收清单", "真人验收", "acceptance test", "让我验收".
---

# Acceptance Checklist — 真人验收清单

给**即将亲手操作系统的真人**用的结构化打勾清单。不是代码审查，不是 curl 冒烟——是"按这张表操作，每一步都告诉我应该看到什么、看不到时按哪个键排错"。

## 目录

- [核心理念](#核心理念)
- [何时用 / 何时别用](#何时用何时别用)
- [执行流程](#执行流程)
- [UAT 文档模板](#uat-文档模板)
- [双通道支持：CLI / Web UI](#双通道支持cli--web-ui)
- [交互模式：逐步打勾](#交互模式逐步打勾)
- [失败处置手册](#失败处置手册)
- [上下游技能](#上下游技能)
- [参考资料](#参考资料)

## 核心理念

**四个不妥协**：

1. **真人视角，不是代码视角**：每步动作必须是"敲这条命令/点这个按钮"，不是"调用这个函数"
2. **可打勾可回溯**：每个 checkpoint 有 ☐ 符号，跑完一项打一个 ✅ / ❌
3. **失败不留悬案**：任何 ❌ 都必须有对应的排查路径（failurePlaybook），不能光说"失败了"
4. **禁止空白等待**：长操作必须有进度反馈（参照 `CLAUDE.md` 规则 #6），不是让用户盯着黑屏猜

**灵感来源**：借鉴 `gsd-verify-work`（开源 UAT skill）的四个核心模式——单步打卡 / 关键词分级 / 冷启动注入 / 降级 fallback——本地化为中文 + 对接本项目的 CLI 集群命令 + Web Dashboard 双场景。

## 何时用 / 何时别用

### ✅ 该用

- 一项功能代码已完成、单元测试通过，准备交给真人跑一遍
- 涉及用户操作路径：CLI 命令序列 / Dashboard 页面 / 桌面端交互
- 新增 Agent / 新增页面 / 新增配置流程 / 新增集群能力
- PR 合并前的最终确认（比 `/handoff` 更细粒度，要真动手跑）

### ❌ 别用

- 纯库函数重构（没有真人入口）→ 用 `/verify` 做代码审查
- API 契约验证（没有 UI）→ 用 `/smoke` 做 curl 链式冒烟
- 纯文档变更 → 不需要 UAT

### 和其他 skill 的关系

| 维度 | `/verify` (human-verify) | `/smoke` (smoke-test) | `/handoff` (task-handoff-checklist) | **`/uat` (acceptance-checklist)** |
|---|---|---|---|---|
| 视角 | 代码 reviewer | 开发者 | 移交文档作者 | **真人用户** |
| 产出 | 问题清单 | curl 脚本 | 交接报告 | **打勾清单 + 排错手册** |
| 何时用 | 写完代码 | 写完 API | 提交 PR 前 | **真人动手前** |
| 自动/手动 | 自动（AI 做）| 自动 | 自动 | **半自动**：AI 生成清单，真人执行 |

## 执行流程

```
UAT 生成进度：
- [ ] Phase 1: 场景收集（问 3 个关键问题）
- [ ] Phase 2: 冷启动注入判定（涉及服务/集群/容器时强制加）
- [ ] Phase 3: 分阶段清单生成（0-准备 → 1-执行 → 2-验证 → 3-回归 → 4-回滚）
- [ ] Phase 4: 失败处置路径逐项填写
- [ ] Phase 5: 输出 Markdown 打勾表 + 总体验收汇总
- [ ] Phase 6: 串联下游 skill 建议
```

### Phase 1: 场景收集（必须先问）

调用此 skill 时必须先收集以下 3 条信息（如果用户没说齐，用 `AskUserQuestion` 追问，不猜）：

| 必填项 | 示例 |
|---|---|
| **功能描述**：这次验收的是什么 | "CDS 集群引导：一条命令让 B 加入 A" |
| **入口**：真人从哪开始操作 | CLI：`./exec_cds.sh connect` / Web：`https://x.miduo.org/review` |
| **场景类型**：CLI / Web UI / 混合 | 混合（先 CLI 建集群，再 Web 验证容量）|

**可选项**（有会更好，没有 AI 自己推断）：

- 预期耗时估算
- 依赖的外部服务（数据库/外部 API/LLM 模型池）
- 已知风险点（从 `/risk` 或 `/verify` 继承）

### Phase 2: 冷启动注入判定

**强制触发条件**：场景描述命中以下任一关键词时，必须在 Phase 0 之前插入"冷启动自检"：

| 触发词 | 冷启动动作 |
|---|---|
| 集群 / cluster / 节点 | `systemctl status` / 进程存活检查 / 端口占用 |
| 服务 / 容器 / daemon | `docker ps` / 相关容器健康检查 |
| 部署 / deploy | 检查构建产物、最新提交哈希 |
| 数据库 / db / mongo / redis | 连接探活 |
| LLM / 模型 | `curl /api/llm-health` 或等效探活端点 |

**原因**：真人经常在"上次失败的残留状态"上测试，测出来的是假阳性。冷启动是 GSD 社区总结的"最容易省略、最致命"的一步。

### Phase 3: 分阶段清单生成

每个 UAT 文档必须包含以下 5 个 Phase（某阶段为空时明确写"本场景无此阶段"）：

| Phase | 含义 | 典型内容 |
|---|---|---|
| **Phase 0: 前置检查** | 跑测试之前必须满足的环境 | 版本、依赖、网络、时间同步 |
| **Phase 1: 核心执行** | 真正要测的新功能主路径 | 敲命令 / 点按钮 / 等结果 |
| **Phase 2: 验证效果** | 检查核心执行是否产生了期望副作用 | 数据库落盘 / UI 更新 / 日志出现 |
| **Phase 3: 回归检查** | 确认老功能没被新改动搞坏 | 既有页面还能访问 / 老 API 还能调 |
| **Phase 4: 回滚演练** | 撤销操作也要能工作 | disconnect / delete / undo |

每个 Phase 内部的行项必须遵循 [UAT 文档模板](#uat-文档模板) 的表格结构。

### Phase 4: 失败处置路径（failurePlaybook）

每个 checkpoint **必须**附加一个 `failurePlaybook` 字段，即"预期结果没出现时，按这个手册排查"。格式：

```
**如果 X.Y 失败**：
- 常见原因 1 → 诊断命令 / 修复步骤
- 常见原因 2 → 诊断命令 / 修复步骤
- 仍然不行 → 贴这几条日志给开发者
```

留一条"仍然不行"兜底的好处：真人遇到非预期情况知道去哪求助，不会卡死。

### Phase 5: 输出格式

见下一节 [UAT 文档模板](#uat-文档模板)。

### Phase 6: 串联下游 skill

UAT 完成后，根据结果提示下一步 skill：

- **全绿通过** → 建议 `/handoff` 生成交接文档
- **部分失败** → 建议 `/verify` 复查代码 或 `/risk` 重评风险
- **回归检查发现老功能坏了** → 建议 `/trace` 追数据流
- **反复出现冷启动相关问题** → 建议把场景写进 `doc/guide.*` 长期沉淀

## UAT 文档模板

**文件名**：`acceptance-{feature-slug}-{YYYYMMDD}.md`（**不写盘除非用户确认**，默认只打印到对话）

**顶部元信息**：

```markdown
# {功能名称} 验收清单

> **验收目标**：{一句话说明}
> **分支**：{branch name}
> **入口**：{CLI 命令 | Web URL}
> **场景类型**：CLI / Web / 混合
> **估算总时长**：{N} 分钟
> **打勾方式**：每个 checkpoint 有 ☐，跑完一项写 ✅ / ❌ / ⏭ (跳过)
```

**每个 Phase 的表格结构**：

```markdown
## 🟢 Phase N: {阶段名}（{预计耗时}）

> {可选的一句话说明：这个阶段在验什么}

| # | 操作 | 预期结果 | 状态 |
|---|---|---|---|
| N.1 | {具体命令或点击动作} | {看到什么 stdout / UI 元素 / 状态码} | ☐ |
| N.2 | ... | ... | ☐ |

**如果 N.1 失败**：
- 原因 A → 诊断命令
- 原因 B → 排查步骤
- 都不行 → 贴 `./exec_cds.sh logs | tail -30` 给我

**验收点 N**：{这个 Phase 的核心价值判断，一句话说清楚跑这组 checkpoint 是在验什么关键事实}
```

**文末总结**：

```markdown
## 🧾 整体验收汇总

| 验收点 | Phase | 你的结论（✅/❌/⏭）|
|---|---|---|
| {point 1} | 1 | |
| {point 2} | 2 | |
| ... | | |

**任一 ❌**：按对应 Phase 的"失败处置"排查；还不行就贴日志
**全部 ✅**：功能正式验收通过 → 建议下一步跑 `/handoff`
```

## 双通道支持：CLI / Web UI

UAT 往往是混合场景，清单必须对两种通道都有标准化的表述：

### CLI 通道

```markdown
| # | 操作 | 预期结果 | 状态 |
|---|---|---|---|
| 1.1 | `./exec_cds.sh connect https://... <token>` | 看到 `[OK] 已加入集群` | ☐ |
```

**预期结果的三要素**（任选其一或组合）：
- stdout 关键字（`grep -q "..." logs`）
- exit code（`echo $?` = 0）
- 副作用文件（`.cds.env` 新增行 / state.json 字段变化）

### Web UI 通道

```markdown
| # | 操作 | 预期结果 | 状态 |
|---|---|---|---|
| 2.3 | 浏览器打开 `https://xxx/review` | 看到标题"PRD 评论" + 列表至少 1 条 | ☐ |
| 2.4 | 点击第一条评论 | 弹出侧边栏，显示作者头像、评论内容、时间 | ☐ |
| 2.5 | 按 F12 打开 DevTools → Network | 有一条 `GET /api/reviews` 返回 200 | ☐ |
```

**Web 通道的强制项**（参照 `.claude/rules/e2e-verification.md`）：
- 不能只调 API，必须真的开浏览器看渲染
- 必须 F12 检查 Network（API 返回 200 ≠ UI 渲染正确）
- 新旧数据都要测（fallback 路径）
- 如有设计稿，对照逐项打勾

### 混合场景示范

```markdown
Phase 1 (CLI)：启动服务
Phase 2 (Web)：Dashboard 验证 UI 同步
Phase 3 (CLI)：再次操作
Phase 4 (Web)：浏览器看到状态变化
```

## 交互模式：逐步打勾

**半自动执行**（默认，推荐）：

1. AI 打印完整清单给用户（顶部总览 + 所有 Phase）
2. 用户自己按顺序操作，**每完成一个 Phase 在对话里回复**：
   - `pass 1.1-1.5` → 标记 1.1-1.5 为 ✅
   - `fail 2.3` + 错误信息 → AI 查 failurePlaybook 给建议
   - `skip 4.*` → Phase 4 全部跳过
3. AI 维护进度面板，每收到一次反馈就更新汇总表

**自动监督模式**（可选，需用户明确请求）：

如果用户说"你帮我一步一步执行"：
- AI 一次只打印一步
- 用户执行完回 `y`（通过）/ `n 错误信息`（失败）
- 失败时 AI 给排查建议，用户尝试修复后回 `retry`
- 禁止 AI 一次性 dump 全部清单（会让用户跟丢）

**关键字自动分级**（借鉴 gsd-verify-work）：

| 用户回复包含 | 自动分级 |
|---|---|
| "crash" / "炸了" / "502" / "timeout" | 🔴 blocker |
| "慢" / "slow" / "等了很久" | 🟡 minor |
| "样式不对" / "布局乱了" | 🟡 minor（UI polish）|
| "不符合预期" / "不对" | 🔴 blocker |
| "看到了" / "对的" / "通过" | ✅ pass |

## 失败处置手册

每个 failurePlaybook 必须同时覆盖三类失败：

1. **预期失败**：文档里列的常见错误 → 给确定的修复命令
2. **环境失败**：依赖没装 / 端口占用 / 时间不同步 → 给探活命令
3. **未知失败**：日志 + 贴给开发者 → 给明确的日志抓取命令

**绝不能写**：
- "失败就重试" （空话）
- "看日志" （不告诉看哪里）
- "问一下管理员" （不告诉问什么）

**必须写**：
- "日志第 X 行会有 `executor registered` 字样，没有的话贴 `./exec_cds.sh logs | tail -50` 给我"

## 上下游技能

```
       /verify → 代码审查通过
              ↓
       /smoke → API 契约冒烟通过
              ↓
       /cds-deploy → 部署到预览环境
              ↓
   → /uat ← 本技能（真人打勾验收）
              ↓
       /handoff → 生成交接文档
              ↓
              PR
```

### 不是替代而是组合

- `/smoke` 告诉你 API 接口是**技术正确**的
- `/uat` 告诉你从**真人体验**看是**业务正确**的
- 两者都过 = 可以合 PR
- `/smoke` 过但 `/uat` 没过 = API 对但用户用不上
- `/uat` 过但 `/smoke` 没过 = 偶发的测试未覆盖路径

## 参考资料

- **标准模板**：[reference/checklist-template.md](reference/checklist-template.md) — 空白模板复制粘贴即用
- **完整示例**：[reference/example-cds-cluster.md](reference/example-cds-cluster.md) — CDS 集群引导功能的 8 Phase 填好版
- **架构灵感来源**：[gsd-verify-work](https://github.com/gsd-build/get-shit-done/blob/main/get-shit-done/workflows/verify-work.md)（GSD 社区开源 skill）
- **项目规则**：
  - `.claude/rules/e2e-verification.md` — 端到端验收强制规则
  - `CLAUDE.md` 规则 #6 — 禁止空白等待
  - `CLAUDE.md` 规则 #8 — Agent 开发"完成"标准

## 合规要求（项目特定）

- **中文输出**：所有 checkpoint 描述和错误提示必须中文
- **不写盘默认**：生成的 UAT 文档默认只打印到对话。仅当用户明确说"保存"时才 Write 到 `/tmp/` 或 `doc/report.*`
- **禁止创建 `doc/` 下的永久文档**：UAT 是一次性产物，不要污染 `doc/` 目录结构
- **预览地址自动化**：Web 场景时用 `preview-url` skill 的逻辑自动生成 `{branch-slug}.miduo.org` 地址
- **参考 `CLAUDE.md` 规则 #9**：新 Agent / 新页面交付必须同时声明【位置】和【路径】两行，UAT 清单顶部应复述这两行
