# 「向我提问」形变坞交接清单

**一句话**：访客页的提问入口重做成同一个 DOM 节点的四态形变，开场问题改由系统读正文自动生成；代码全部就位，但「答案真的流出来」这一跳因环境问题至今未验。
**谁该读**：接手这条分支的人、决定要不要合并的人、以及安全基线那条线的负责人。
**读完能做什么**：知道改了什么、哪些有证据、哪一步卡在哪、下一步该找谁。

版本：2026-08-27 | 分支 `claude/web-hosting-feature-description-d2gbck`

## 一句话结果

访客在托管页面上问问题的入口，从「一个按钮 + 一个抽屉」变成一件会形变的东西（胶囊 → 中下玻璃长条 → 右侧对话栏 → 竖条），开场问题不再要上传者手填。**当前不可交付**：预览环境的后端起不来，最后一跳没验过。

## 改动范围

- 基线：`origin/main`，merge-base `31e10ae9`
- 本轮（提问坞起点至今）：26 个文件，+2173 / -215
- 模块：访客页与提问组件（坞与对话流、配置抽屉、主题 token）、后端提问服务（开场问题生成、重新生成端点、退配额）、CDS 预览编排（网关调用方白名单）

## 使用与验收

- **入口**：访客分享页右下角胶囊（站点需开启提问）；owner 侧在站点「提问设置」抽屉里看题库来源与「重新生成」
- **操作步骤**：打开分享链接 → 点右下角胶囊 → 挑一条浮在长条上方的问题或自己敲 → 右侧展开对话
- **预览**：https://web-hosting-feature-description-d2gbck-claude-prd-agent.miduo.org/ （取自 cdscli，非拼接）；**当前后端容器起不来，接口全断**
- **登录**：访客路径匿名可用；owner 路径需平台账号，凭据走既有安全渠道，不在本文出现

## 八维检查

| 维度 | 状态 | 证据或待办 |
|---|---|---|
| 入口与使用路径 | 已完成 | 四态几何在真机逐态量过（收起 132×40 / 长条 660×54 居中 / 对话 400×视口高 / 竖条 44×视口高），`.ask-dock` 全程只有一个节点 |
| 文档与决策 | 已完成 | [debt.web-hosting.md](./debt.web-hosting.md) 新增 #56–#62，含一条我自己走错的弯路（误判成去 MAP 建池） |
| 契约与数据 | 已完成 | `HostedSite` 新增 `AskQuestionsSource` / `AskQuestionsGeneratedFor`；新增端点 `POST {siteId}/ask/questions/regenerate`；新增 AppCaller `…ask-openers::intent`（黄金快照已同步） |
| 测试与证据 | 部分 | 前端 196 文件 / 1648 用例全绿、tsc 零错误；后端新增 12 条单测与守卫；**端到端最后一跳未验**（见下） |
| 发布与运维 | 待办 | compose 改动需 CDS 受审导入；生产是否一并把两个 caller 切到 HTTP 权威未决 |
| 安全与隐私 | 已完成 | 未引入新凭据；提问上下文由服务端取，不接受前端传入正文；调试用隧道已关闭 |
| 已知风险 | 已记录 | 见 [debt.web-hosting.md](./debt.web-hosting.md) #56–#62 |
| 后续行动 | 见下表 | |

## 已运行验证

| 命令或路径 | 断言 | 结果 |
|---|---|---|
| `pnpm vitest run`（全量） | 196 文件 / 1648 用例 | 全绿 |
| `pnpm tsc --noEmit` | 零类型错误 | 通过 |
| CDS 远端编译（GitHub Actions） | C# 零 error | 通过（`a48600a6` 起） |
| 真机四态（HTML / Markdown / 幻灯片 / 多文件 ZIP / PDF） | 几何、单节点、角标、额度真减 | 五类一致通过 |
| 真机手机端 390×844 | 三态、满宽长条、整屏对话、让开手势条 | 通过 |
| 提问端点直打（五类站点） | 不返回 `ASK_NO_CONTENT` | 五类正文快照全部取得到 |
| 视频包装站开提问 | 后端明确拒绝并说明原因 | 返回 `ASK_UNSUPPORTED` |
| 重新生成端点 | 模型不可用时不盖版本戳、给可执行文案 | 实测 `ModelUnavailable`，戳由已写回退为 `null` |
| **访客真问一句看到答案** | **答案流式长出来** | **未验** —— 至今没有过一次成功的模型调用 |
| **开场问题自动生成** | **真写出 5 条** | **未验** —— 同上 |

## 风险与后续

| 事项 | 影响 | 优先级 | 负责人 | 完成条件 |
|---|---|---|---|---|
| 共享 Mongo / Redis 开鉴权后应用侧拿不到凭据 | prd-agent 任何分支下次重启都起不来 | P0 | 安全基线那条线 | 容器能连上并启动 |
| 恢复用 compose 导入 `ee2174a9e141` 待批 | 不批则整个项目卡在模板展开阶段 | P0 | 项目负责人 | 导入落终态 |
| 最后一跳未闭环（答案流 / 开场问题） | 功能不能声称跑通 | P1 | 本分支 | 环境恢复后重跑并留截图 |
| 生产是否一并切 HTTP 权威 | 生产仍走 inproc | P2 | 待定 | 明确决定 |
| 我在预览环境留了 4 个 `[坞验收]` 测试站点 | 轻微数据噪音 | P3 | 本分支 | 确认不再需要后删除 |

## 实现来源

给要跳去看代码的人；只读本文的人可以整块跳过。

| 位置 | 文件 |
|---|---|
| 形变坞与几何守卫 | `prd-admin/src/components/web-hosting/ask/AskDock.tsx`、`askDockGeometry.ts`、`askDockGeometry.test.ts` |
| 共用对话流 | `prd-admin/src/components/web-hosting/ask/AskThread.tsx` |
| 开场问题生成 | `prd-api/src/PrdAgent.Infrastructure/Services/AskOpeningQuestionGenerator.cs`、`prd-api/src/PrdAgent.Core/Models/AskOpeningQuestions.cs` |
| 退配额与重新生成端点 | `prd-api/src/PrdAgent.Api/Controllers/Api/WebPageAskController.cs` |
| 网关白名单 | `cds-compose.yml` |
