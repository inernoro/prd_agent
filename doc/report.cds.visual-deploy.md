# CDS 绝对可视化一键部署 · 完整报告

> **类型**：report（做了什么） · **日期**：2026-06-02 · **分支**：`claude/fervent-mayer-a8qlf`
> **关联**：`design.cds.visual-deploy.md`、`plan.cds.visual-deploy.md`、`debt.cds.visual-deploy.md`、`guide.cds.one-click-deploy.md`
> **一句话**：围绕"把 CDS 做成商业级、不反感的隔离 sandbox 一键部署"的目标，本会话连续交付并验证了一整条 onboarding→部署闭环，独立子智能体最终视觉验收 Verdict 通过、无 P0/P1。

---

## 1. 交付总览（按交付顺序）

| 增量 | 关键改动 | 验证 |
|---|---|---|
| 弹窗版式修复（P0） | shadcn `DialogContent` 缺高度 cap → 高弹窗内容飞出视口、主操作够不到。改 inline `maxHeight:90vh` + 内层滚动 + 关闭按钮固定 | 视觉前后对照 + harness 版式护栏 |
| 基建注册表 SSOT + 消息队列 | `infra-catalog.ts` 单一注册表（12 预设含 Kafka/NATS/ES/MinIO）；`GET /api/infra/catalog`；前端 + 拓扑选择器都读它 | tsc + vitest + API 实测 12 项 |
| 多应用服务 | 前端从写死 2 个解开为动态增删（角色 前端/后端/后台任务），后端早支持任意数量 | 视觉（加到 3 个）|
| 数据库名 + 初始化 SQL | 目录 build() 支持 dbName；InfraService 存 dbName/initSql；数据面板「载入初始化 SQL」 | 单测 9 例 + API（env.POSTGRES_DB=shop_prod）|
| 同类型多数据库实例 | `applyInfraPresets` 实例化（首个零改动，第 2+ 个 `-N` 容器 + `_N` 连接串、host 改写）；`instanceConnectionEnv` 纯函数 | 单测 + API（postgres + postgres-2、DATABASE_URL/_2）|
| env 就地粘贴 | 创建弹窗粘贴 `.env` 文本，创建时一并写入 customEnv | API（JWT_SECRET/API_BASE 落库）+ 视觉 |
| 后端默认 auto | 后端运行时默认改「自动识别」，不写死 Node 命令；命令标注可编辑 | 视觉 |
| 试运行验证沙箱 | `POST /api/validate-runtime` SSE：一次性容器 clone→跑→探活→三档结论 + 智能提示 | API（PASS/FAIL）+ 视觉（绿/红）|
| 检测回填 | `POST /api/detect-runtime`：克隆 + `detectModules` → 真实配置回填 | API（Node→Express、Python→Flask 准确）+ 视觉 |
| 检测置信度透明 | 返回 confidence/signals/stack；前端「把握 高/中/低」+ 不确定劝验证 | API（0.95/0.9 + 依据）|
| 应用已上线高光 | 分支列表带 previewUrl；详情抽屉 running 时绿色横幅 + 一键打开 | 视觉（main 分支横幅 + URL）|

## 2. Dogfood 发现并修复的真 bug（拿 5 个真实项目试出来的）

用 5 个真实仓库（Node/Express、Python/Flask、Go monorepo、.NET、空仓库）跑试运行验证，5/5 失败，暴露：

1. **致命**：bind-mount 用主机路径，容器化 CDS（宿主 docker socket）下挂的是宿主空目录 → 所有真实仓库报"找不到 package.json"。早期"PASS"是 `python http.server` 不读仓库文件侥幸过的，掩盖了 bug。**改 docker cp 装载代码后修复**（Node/Flask 真跑通）。
2. **PATH**：`sh -lc`（login shell）重置 PATH → golang 镜像 `go: not found`。**改 sh -c**。
3. **假告警**：`python:slim` 无 wget/curl → Flask 起来了却被探活误判"端口未响应"。**改读 `/proc/net/tcp` 判 LISTEN**。
4. **提示不够**：失败只报退出码。**改为按日志认根因给可操作提示**（缺 package.json/requirements.txt/Go 主包 → 可能在子目录；NETSDK 版本不匹配；端口占用；缺命令换镜像）。

复测：Node→通过、Flask→通过（假告警修好）、Go→不通过 + "代码可能在子目录"智能提示。

## 3. 验收（全部进知识库，可点开）

| 验收 | Verdict | 分享链 |
|---|---|---|
| 可视化部署增强（首轮） | 通过 | `/s/lib/UIGgA5u66AEn` |
| 弹窗撑破修复（含 risk-matrix） | 有条件通过 | `/s/lib/4Xj_QzpfpyO0` |
| 多服务 + 库名/initSQL | 通过 | `/s/lib/18lkLG484AFZ` |
| 多DB实例 + env粘贴 + 自动识别 + 少绕路 | 通过 | `/s/lib/XtaJ_6irGB9z` |
| 试运行验证配置闭环 | 通过 | `/s/lib/uAzOa7wnA8gk` |
| onboarding 全流程（最终，子智能体跑） | 通过 | `/s/lib/Bp5k5JaKjTOR` |

（均托管在 `fervent-mayer-a8qlf-claude-prd-agent.miduo.org`，库私有 + 分享 token；另发布「CDS 部署验收知识库」store `2f0f472f`。）

## 4. 质量与方法

- **自测路径**：tsc（cds + web 全绿）、vitest（含 dbName/instanceConnectionEnv 9 例新单测）、API 实测（detect/validate/多DB/env 真实返回）、Playwright 真人路径视觉取证（X-AI-Access-Key 认证为 admin，禁地址栏直达）。
- **反哺验收技能**：因"功能在却版式撑破被判 PASS"，给 `create-visual-test-to-kb` 的 harness 加了**版式撑破自动护栏**（合成用例验证抓撑破、不误报已修复）+ standard-v2.md §5.2「读图必查版式健康」。
- **部署方式**：CDS 自身经 `self-force-sync` 拉本分支上线（`cds.miduo.org`），全部增量 live 可验。

## 5. 结论

核心目标——"纯前端一键部署任意前后端 + 数据库 + 消息队列、不反感、隔离 sandbox"——的 onboarding→部署链路已达成并经独立子智能体验收（通过，无 P0/P1）。部署机制（SSE、日志、重启恢复、TCP+HTTP 就绪探测、依赖拓扑、预览域名）经勘探确认扎实。剩余为低边际打磨项，见 `debt.cds.visual-deploy.md`。
