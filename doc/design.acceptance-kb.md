# 验收报告知识库 · 设计

> **版本**：v1.0 | **日期**：2026-05-30 | **状态**：已落地（后端 B/C 经预览域名端到端自测通过；前端 A 徽章已类型+数据验证，待真人视觉确认）
> **关联实现**：`prd-api/.../DocumentStoreController.cs`、`prd-admin/.../DocBrowser.tsx`、`.claude/skills/create-visual-test-to-kb/`
> **关联设计**：`design.acceptance-system.md`（验收体系主文档）、`debt.knowledge-base.md`、`debt.acceptance-system.md`
> **一句话**：把"验收报告堆进一个平铺知识库、看不出新旧也看不出通过没通过"升级为"最新在前、结论可视、结构受模板约束、可跨环境同步"的质量资产库。

---

## 1. 管理摘要

验收报告归档进知识库后，三件事一直没做好：

1. **看不出新旧**：归档库 owner 视角的目录按标题字典序排，而验收报告标题恒定（`项目·模块·功能·类型·验收报告`），导致最新一次验收永远不在最前，同名报告还会乱簇。
2. **看不出结论**：通过 / 有条件通过 / 不通过只埋在 tag 里，列表里和普通标签长一样，一眼分不出这份是绿还是红。
3. **约束活在技能里**：报告"该长什么样"的规则写在验收技能的 `standard-v2.md`，换个来源（人工 / 别的 agent）写进同一个库就失控，知识库本身不卡。

本设计分三块解决，互相独立、可分批落：

- **A 排序与结论可视**：验收类知识库 owner 视角强制"最新在前"，并把 verdict 渲染成绿/琥珀/红状态徽章（数据走 `entry.metadata`，不解析标题）。
- **B 模板化知识库**：给 `DocumentStore` 引入 `templateKey`，把"报告该长什么样"的约束从技能下沉到库——任何来源写入都被同一套规则校验，不合规拒收（机器硬卡、人工软提醒）。
- **C 跨环境同步**：导出 / 导入端点 + 一行 CLI，把验收报告库在测试 / 正式环境之间搬运，幂等去重。

读者只需记住：**验收报告库要做到"打开就看见最新、扫一眼就知道通没通过、写进去就被规矩约束、换环境能整库搬"。**

---

## 2. 背景与现状

知识库（文档空间）的实现散落在：

- 后端：`DocumentStore` / `DocumentEntry` 模型 + `DocumentStoreController`（条目列表已按 `IsFolder DESC, CreatedAt DESC` 排序）。
- 前端：`DocBrowser` 共享组件，三处复用（知识库编辑 / 分享只读 / 周报）。owner 编辑页 `DocumentStorePage` 渲染 `DocBrowser` **未传 `sortMode`**，落到默认 `'default'`（标题字典序）。
- 技能：`create-visual-test-to-kb` 的 `archive_report.py` 通过 `AI_ACCESS_KEY` + `X-AI-Impersonate` 写入名为"验收报告"的库，verdict / tier 仅放进 `tags`。

关键事实（实现约束）：

- `DocumentEntry.Metadata`（`Dictionary<string,string>`）与 `AddDocumentEntryRequest.Metadata` **已存在**，verdict 可干净落库，无需新增模型字段。
- `DocBrowserEntry.metadata` 前端类型已存在，`DocumentStorePage` 的 `entries` 直接透传，metadata 天然流通。
- `DocumentStore` **无任何 template 字段**，B 需要新增。
- `PUT /entries/{id}/content` 用正文首 200 字重算 summary，**无任何结构校验**，B 的校验正好补这个洞。

---

## 3. 目标与非目标

**目标**

- 验收库 owner 视角"最新在前" + verdict 状态徽章 + 默认显示时间。
- 知识库可声明模板，写入按模板校验结构 / 必填字段。
- 验收报告库可跨环境导出 / 导入（文本类）。

**非目标（本期不做）**

- 二进制附件（截图）的跨环境同步——v1 只搬文本正文，bundle 标注 skipped。
- 给所有知识库做通用模板系统——本期只注册 `acceptance-report-v2` 一个模板。
- 重做分享阅读页排序（分享页已是 `created-desc`，本就正确）。
- 跨环境同步二进制附件（截图）——本期只搬文本正文。

---

## 4. 用户场景

- **QA / 开发** 打开"验收报告"知识库 → 目录顶部就是最近一次验收，红色"不通过"徽章一眼可见 → 点开看证据。
- **技能 / 别的 agent** 归档报告 → 缺"结论"section → 后端 422 拒收并列出缺失项 → 不会留下断头报告。
- **运维** 在测试环境验证完一批报告 → `kb-sync` 一行命令推到正式环境，重复跑不产生重复条目。

---

## 5. 方案设计

### 5.A 排序与结论可视

| 改动 | 位置 | 说明 |
|------|------|------|
| owner 视角传 `sortMode` | `DocumentStorePage.tsx` | store 命中验收模板时传 `created-desc` + 默认显示时间 |
| verdict 状态徽章 | `DocBrowser.tsx` + 新增 `acceptanceVerdictRegistry.ts` | 读 `entry.metadata.verdict`（`pass`/`conditional`/`fail`）→ 绿/琥珀/红 + 文案 + `tier` 档位，注册表模式（禁 switch） |
| 落库 metadata | `archive_report.py` | 创建 entry 时写 `kind=acceptance-report`、`verdict`、`tier`、`acceptedAt`、`reportId` |

判定"这是验收类 store"：依据 B 引入的 `store.templateKey === 'acceptance-report-v2'`。徽章渲染本身按 `entry.metadata.verdict` 存在即渲染，不依赖 store（对单篇分享同样生效）。

### 5.B 模板化知识库

1. `DocumentStore` 新增 `TemplateKey`（`string?`）；`CreateDocumentStoreRequest` / `UpdateDocumentStoreRequest` 同步加（涟漪：模型 / DTO / 前端 contract / 卡片）。
2. 新增后端 `AcceptanceTemplateRegistry`（仿 `ReprocessTemplateRegistry` 写法），首版注册 `acceptance-report-v2`，声明：
   - 必备 metadata 键：`verdict`（枚举 `pass`/`conditional`/`fail`）、`tier`、`target`
   - 必备正文 H2 section：`需求一一对应表`（标准 v2 §6.4 唯一强制的语义 H2；其余正文走 ZZ「## 步骤 N」风无固定标题，故只校验这一个，对机器归档零误伤、对外部写入者兜底）
3. 写入校验在 `AddEntry`（metadata）与 `UpdateEntryContent`（正文 section）：
   - store.TemplateKey 命中模板 → 校验
   - **机器调用（带 `kind=acceptance-report` metadata 或非 folder 文本）硬卡**：不合规返回 422 + 缺失项清单
   - **人工手写软提醒**：缺 section 不拦，但 metadata 标 `templateCompliant=false`（前端给提示）
4. 模板校验逻辑做成纯函数 `AcceptanceTemplateRegistry.Validate(content, metadata)` → 返回缺失项列表，供单元测试直接断言（无需 DB）。

### 5.C 跨环境同步

| 端点 | 方法 | 说明 |
|------|------|------|
| `stores/{id}/export` | GET | 返回 bundle JSON：store 元信息（含 templateKey）+ 文件夹树 + entries（tags/metadata）+ 每条正文 markdown；二进制附件标 skipped |
| `stores/import` | POST | 按 bundle 重建；幂等：按 `metadata.reportId` 去重，存在则跳过 |

CLI：`.claude/skills/create-visual-test-to-kb/scripts/kb_sync.py --store 验收报告 --from <url> --to <url>`，内部 export → import，鉴权优先 `MAP_DOC_STORE_KEY` scoped key（见 5.D）、无则回退 `AI_ACCESS_KEY` + `MAP_AI_USER`，返回 `{created, skipped, failed}` 统计。归属在验收技能下而非 cdscli（cdscli 是 CDS 控制面，打的是 app 的 `/api/document-store`，属不同层）。

### 5.D 最小权限写入（document-store:write scoped key）+ 自动子文件夹

- **scoped key**：新增 `document-store:read` / `document-store:write` AgentApiKey scope。`AdminPermissionMiddleware` 增加「scope `a:b` 精确满足 admin 权限 `a.b`」的映射（仅精确等值，不跨资源泄漏），`ApiKeyAuthenticationHandler` 给 AgentApiKey 补 `sub` claim 使其以 owner 身份执行。归档/同步脚本优先用 `MAP_DOC_STORE_KEY`（Bearer），替代 AI 超级密钥——最小权限、无 impersonate、可单独撤销。未设则回退超级密钥（向后兼容）。
- **自动子文件夹**：归档时按 `--module`（无则 `YYYY-MM`）find-or-create 根级子文件夹，条目挂其下，验收库不再平铺成几百条。

---

## 6. 数据设计

- `DocumentStore.TemplateKey`（新增，`string?`，null = 普通库不校验）。
- `DocumentEntry.Metadata` 约定键：`kind` / `verdict` / `tier` / `target` / `acceptedAt` / `reportId` / `templateCompliant`（复用现有字典，无模型变更）。

---

## 7. 接口设计

- `POST /stores`、`PUT /stores/{id}`：请求体加 `templateKey?`。
- `POST /stores/{id}/entries`：命中模板时校验 metadata，失败 422 `{ code, message, missing: [...] }`。
- `PUT /entries/{id}/content`：命中模板时校验正文 section，机器硬卡 / 人工软提醒。
- `GET /stores/{id}/export`、`POST /stores/import`：见 5.C。

---

## 8. 风险

| 维度 | 风险 | 缓解 |
|------|------|------|
| 兼容 | 历史报告无 verdict metadata | 徽章 metadata 缺失时不渲染（优雅降级）；排序不依赖 metadata |
| 正确性 | 模板校验误伤人工文档 | 人工软提醒不拦，仅机器硬卡 |
| 安全 | export/import 走超级密钥 | 端点要求 DocumentStoreWrite 权限；列入 debt 待换最小权限 key |
| 运维 | 跨环境重复同步 | reportId 幂等去重 |

---

## 9. 落地顺序

`B（模板字段 + 校验）→ A（排序 + 徽章 + metadata 落库）→ C（export/import）`。B + A 合一个 PR（前端徽章依赖后端 templateKey）。C 独立。
