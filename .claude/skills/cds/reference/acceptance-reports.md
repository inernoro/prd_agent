# CDS 验收报告 / 视觉取证（按需加载）

> 沉淀自 2026-06 的「CDS 这几天修改 MECE 验收」会话：把 **视觉取证 → CDS 自托管验收报告 → 项目/文件夹归类 → 直达深链** 做成可复用流程，以后不必每次重搭。

## 何时用

- 要对 CDS（或经 CDS 部署的应用）做**视觉验收**，并把结论 + 带框截图**逐项留档**、可检索、可分享给登录用户。
- CDS 报告按设计是**登录态门控**（挂在 CDS 登录之后，无需知识库）。要给未登录第三方看需另起匿名 token 分享（暂未实现）。

## 三步流程

### 1) 取证（真实浏览器，模拟人类）
`cli/acceptance/` 里：
- `proxyroute.mjs` —— **关键工程解**：本环境 chromium 自身网络栈穿不过 agent 出口代理（`page.goto` 报 `ERR_CONNECTION_CLOSED`），但 node fetch 在 `NODE_USE_ENV_PROXY=1` 下可以。于是 chromium 不配代理，用 `context.route` 拦截全部请求改由 node fetch 取回 + cookie 双向桥接。
- `cds-harness.mjs` —— `launchCds(cfg)` 包装：装上 `proxyroute` + 复用 `create-visual-test-to-kb/scripts/harness.mjs` 的 page-helper（`login / gotoByClick / shot / box / stepClick / stepShot / setTheme / writeManifest`）。
- `cds.config.example.json` —— 取证 CDS 自身用 **CDS admin** 登录（`CDS_USERNAME` / `CDS_PASSWORD`，与应用登录区分）。复制为 `cds.config.json`。
- `driver.template.mjs` —— 取证剧本模板（登录 → 点导航进入 → 带框截图 → `writeManifest`）。

运行：`NODE_USE_ENV_PROXY=1 node your-driver.mjs`（`HTTPS_PROXY` 须在 env）。
注意：截图必须**真人路径**（登录后点导航进入，禁地址栏直达业务页）；指向性证据务必画框（`stepClick`/`stepShot(highlight)`/`box`）；预览注入页（热重启等待页/墓碑/版本 pill）要用**浏览器导航头**才会出现（curl 裸 GET 只拿到纯文本 503）。

### 2) 组装 HTML
`build_report_html.py --title --verdict --body-file --manifest --out report.html`
- body 片段用 `{{IMG:name}}` 占位（name 对应 manifest 的 shots[].name）；脚本把截图 base64 内联进自包含 HTML。
- 单份 < **10MB**（超了先把 PNG 压成 JPEG / 缩到 ~1280px 宽，否则 base64 撑爆）。

### 3) 入库 + 归类 + 直达
```
cdscli report-folder create --name "2026-06 这几天 CDS 验收"        # 建文件夹(可 --project)
cdscli report create --title "CDS · X · 验收报告" --html-file report.html --folder <folderId> [--project <id>]
cdscli report deeplink <reportId>     # 打印 /reports?folder=&report= 直达深链(点了直接打开该报告)
cdscli report list --folder <folderId>
```
报告页：`https://<CDS_HOST>/reports`（项目卡右上角「验收报告」入口可按项目进入；左侧文件夹栏归类）。

## 后端契约（供排障）

- 报告：`POST/GET/PATCH/DELETE /api/reports`，`AcceptanceReportMeta{ id,title,format(html|md),projectId?,branchId?,folderId?,sizeBytes,... }`，正文存盘 `<dataDir>/reports/<id>.<ext>`，10MB/份；HTML 在 sandbox iframe（无 same-origin）渲染。
- 文件夹：`GET/POST/PATCH/DELETE /api/report-folders`（`ReportFolder{ id,name,projectId?,sortOrder,createdAt }`）；删文件夹其中报告改未归类、不删内容；项目级 key 只能管自己项目（沿用 PR #865 鉴权）。
- 深链：`/reports?project=&folder=&report=`（前端 `ReportsPage` 读 query 自动选中 + 高亮文件夹）。

## 已知边界

- SSE/EventSource 长连接不走 `route.fulfill`（取静态状态截图够用，实时流不适合）。
- 预览子域名标签 > 63 字符（DNS 上限）会 `ERR_CONNECTION_CLOSED`，与本流程无关，属 `preview-slug` 待办。
