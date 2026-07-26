---
name: tutorial-daily-maintain
description: 维护产品页面、教程步骤与截图证据的双向关系。扫描提交增量，验证页面到教程及教程到页面反链，执行固定种子的随机抽检，仅在命中相关变化时输出漂移报告或更新草稿。默认不自动修改教程正文、截图、DailyTips seed 或远端知识库。适用于 LLMGW 权威教程，也保留 DailyTips 页面教程适配流程。触发词包括“维护教程”“教程双链”“教程日常维护”“教程更新提醒”“tutorial maintain”和“/tutorial-daily-maintain”。
---

# 教程双链维护

## 目标

把“改了页面后是否要更新教程”变成可验证关系，而不是依赖记忆或语言判断。

本技能维护四类事实：

1. 产品表面：路由、页面、共享组件、接口和主题。
2. 教程位置：sourceId、源文件和稳定步骤标记。
3. 验收证据：截图 ID、状态、主题、视口和已验证提交。
4. 双向关系：页面可找到教程，教程也可反查页面、路由和证据。

关系的运行时权威状态保存在 MAP `TutorialLinkGraph`。Git 中的 manifest、维护映射和证据表是可版本化的生成输入、校验规则与回滚来源，不是第二份可人工编辑的关系 SSOT。

LLMGW 的契约见 [reference/bilink-contract.md](reference/bilink-contract.md)。

## 触发与边界

- 手动触发：用户要求维护教程、检查教程漂移或更新教程证据。
- 定时触发：每日质量维护任务调用本技能的“报告模式”。
- 无相关增量：输出 `status=skipped` 后结束，不打开浏览器、不生成报告、不通知、不修改教程。
- 有相关增量：先检查关系和随机检测点，再给出 `review_required`、`drift` 或 `synced`；校验通过时允许把新关系写成 MAP Draft。
- 默认不改内容：不自动修改教程正文、截图、DailyTips seed，也不自动发布 MAP Draft。
- 只有用户明确要求更新教程，且检测结果指出具体 sourceId、stepId 和 evidenceId 时，才进入内容更新与发布流程。

定时任务调用技能不等于授权自动改正文。定时任务始终使用报告模式。

## LLMGW 工作流

### 1. 冻结增量

优先使用“上次成功提交到当前目标提交”的闭区间；只有没有游标时才使用时间窗口。记录 base SHA、target SHA 和运行幂等键：

```text
llmgw-tutorial-link:<baseSha>:<targetSha>:<schemaVersion>
```

同一幂等键成功或已跳过后再次运行，必须直接退出。失败时不推进游标。

### 2. 执行双链扫描

```bash
python3 llmgw/tutorial/maintenance.py \
  --base-ref "$BASE_SHA" \
  --json-out /tmp/llmgw-tutorial-link.json \
  --markdown-out /tmp/llmgw-tutorial-link.md \
  --fail-on-drift
```

扫描器必须同时检查：

- `maintenance-map.json` 中页面、路由和 change source 是否存在。
- manifest 中的教程是否都能反查页面，`book-index` 除外。
- `tutorialLinks` 的 step marker 是否恰好出现一次。
- `evidenceIds` 是否在 `evidence-map.json` 注册。
- 截图验收提交是否为当前提交祖先。
- 新页面、共享组件、主题和后端接口变化是否被正确命中。

### 3. 先抽检再判断

只要命中相关变化，就按 target SHA 生成固定随机种子，至少抽 5 个页面。每个样本检查页面文件、路由、教程源、反链、变更源、步骤标记和证据注册。

需要强制复核时：

```bash
python3 llmgw/tutorial/maintenance.py \
  --since "0 seconds ago" \
  --force-audit \
  --seed "$TARGET_SHA" \
  --sample-size 5 \
  --fail-on-drift
```

报告必须写出种子、样本 ID、每个断言和失败项。只写“已随机检查”不算验收。

### 4. 分类影响

- `content`：操作、权限、接口或业务语义可能变化。
- `screenshot`：布局、主题、组件或状态可能使图片过期。
- `tutorial`：教程源或证据表自身发生变化。
- `coarse-review-required`：只有章节级关系，尚未迁移到步骤级，不能声称已同步。
- `step-linked`：具备 sourceId、stepId 与 evidenceId 的闭环关系。

页面和任意关联教程同时改过，不代表全部已同步。只有具体步骤和证据在目标提交通过校验，才允许记为 `synced`。

### 5. 输出或更新

报告模式输出：

- 变更区间与幂等键。
- 页面到教程表。
- 教程到页面表。
- 随机抽检种子、样本和断言。
- 受影响步骤、证据及 P0 至 P2 漂移。
- 明确的跳过原因或更新草稿。

当状态不是 `skipped`、P0/P1 为 0 且项目级最小权限发布 Key 可用时，将当前图谱只写入 MAP Draft：

```bash
python3 llmgw/tutorial/publisher.py graph-draft \
  --store-id "$MAP_TUTORIAL_STORE_ID"
```

必须记录服务端返回的 `graphSha256`。这一步不修改教程正文，不覆盖 Published，也不产生可见教程变更。缺少 Key 时输出“Draft 未同步”并继续保留本地报告，禁止在日志中打印 Key。

用户明确批准更新时，才依次修改教程源、补证据、运行发布器检查、生成 publisher plan。`apply` 在教程内容读回成功后发布同一图谱 Draft，并在第二次 apply 验证教程节点和图谱均为 noop。

## DailyTips 适配

非 LLMGW 的 DailyTips 页面教程继续使用：

- 教程目录：`DailyTipsController.BuildDefaultTips`。
- 页面关系：`actionUrl`、sourceId 与页面 `data-tour-id`。
- P0：教程引用的常驻锚点不存在或重复。
- P1：核心能力新增但没有步骤。
- P2：锚点落在非稳定弹层或下拉项。

更新提醒保持 `tier=advanced` 和 `<page>-update-<YYYY>w<WW>`，不得重弹整套 basic 新手教程。

## 定时任务隔离

每日验收和教程维护属于“每日质量维护”同一分类，但必须由两个独立 Agent 运行：

- 每日验收 Agent：负责真实浏览器取证与 Verdict。
- 教程双链 Agent：负责静态关系、漂移和证据图谱。

两者不得共享 memory、临时目录或登录凭据。一个任务失败不能覆盖另一个结果。教程任务无相关增量时必须静默跳过。

## 红线

- 不用“教程文件也改了”推断教程已同步。
- 不用图片总数推断截图覆盖正确。
- 不使用固定“最近一天”作为长期唯一游标。
- 不在报告、日志和 memory 中写入密码、Key 或令牌。
- 不自动改教程正文，不自动把图谱 Draft 发布为 Published。
- 不把教程健康报告冒充产品验收 Verdict。
