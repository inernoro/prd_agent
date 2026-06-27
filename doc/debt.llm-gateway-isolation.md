# debt.llm-gateway-isolation

> 状态：进行中（波1 大部分落地，serving 跨进程 = 波2 未做）
> 负责人：AI / 待用户 1 次审批
> 关联设计：`doc/design.llm-gateway-physical-isolation.md`

AI 大模型网关从 MAP 剥离的工程债务台账。记录「已做 / 待用户 / 已知边界 / 后续」。

## 已落地（已部署 + 已验证）

- **观测性补强**（commit e98a9c7e / 55665736 → 5973abee 部署）：
  - 请求生命周期可视（StartedAt/FirstByteAt/EndedAt 派生「未发出/接收中/已发等响应/完成/失败」）。
  - 黑洞可见：StartAsync 失败补落 `Status=blackhole`，让「完全没发出去」也入库可见。
  - 内容一键还原：`GET /api/logs/llm/{id}/restore-text` 还原 `[TEXT_COS:sha:chars]` 占位符。
  - 按应用聚合 MECE：`GET /api/logs/llm/app-summary` 按 appPrefix × requestType 出成功率/中位时延矩阵。
    实测能发现真实异常（visual-agent/generation 44%、document-store/asr 0%、video-agent/asr 38%）。
- **前端观测接线**（7fddd26a + c4746e20，已部署）：日志页「应用」tab + 正文一键还原 + 生图缩略图渲染。
- **生图统一入口**（039e3397）：`ImageGenRequestBuilder` 收口「模型配置→请求体」转换，加新生图模型不再连锁全系统。
- **独立网关进程 prd-llmgw**（444e987a，镜像已构建绿）：自包含 ASP.NET 服务，**不引用任何 prd-api 项目**，
  共享同一 Mongo 直接读 `llmrequestlogs` 做观测，独立 JWT 账号体系（独立 `LlmGwJwt` 密钥 + 种子账号）。
  端点 `/gw/healthz` + `/gw/auth/login` + `/gw/logs(/meta|/timeseries|/sessions|/:id)`，与独立前端
  `prd-llmgw-web` 的 `/gw` 契约对齐。CI `llmgw-image` / `llmgw-web-image` 独立构建，编译失败不波及 api 主镜像。
- **部署管线**：docker-compose（exec_dep 路径）+ cds-compose（预览路径，dev 源码 + express 预构建两模式）+
  `_standalone.conf` `/gw` 反代 + branch-image.yml CI 任务，全部就位。

## 待用户（1 次手动，外部门禁）

- **CDS 拓扑导入审批**：cds-compose 新增 `llmgw` 服务属于「拓扑变更」，CDS 要求 dashboard 人工批准，
  AI key 无法自批。已提交 pending-import `2db2aa51c74e`（项目 prd-agent，addedProfiles=[api,admin,llmgw]）。
  - 批准入口：CDS Dashboard → project-list?pendingImport=2db2aa51c74e → 批准。
  - 批准后预览域名 `/gw/healthz` 应返回 `{"status":"ok"}`，即可 curl 验收
    `/gw/auth/login`（admin / llmgw-admin-2026）+ `/gw/logs`，完成网关运行时闭环验收。
  - 在此之前：网关代码已编译绿、镜像已推；仅「预览域名运行时」这一步卡在审批。exec_dep 路径不受此门禁影响。

## 已知边界 / 后续（波2-3，未做）

- **serving 跨进程（阶段2-3）未做**：当前 prd-llmgw 只承接「观测 + 登录」，**不**代理 LLM 调用本身
  （`/gw/{resolve,send,stream,raw,pools}` 未实现）。MAP 的 chat/生图 serving 仍是进程内 `ILlmGateway` 直调。
  - 真·跨进程 serving 需要网关侧持有 LLM 实现（引用 Infrastructure 的 LlmGateway/ModelResolver），
    即走 `prd-api/src/PrdAgent.LlmGateway`（已 scaffold，引用 Infrastructure）加 Program.cs + serving 端点，
    再在 MAP 侧加 `HttpLlmGatewayClient : ILlmGateway` + feature flag `LlmGateway__Mode=inproc|http`（默认 inproc）。
  - 风险：该项目被 api csproj ProjectReference，编译错误会阻塞 api 主镜像；且跨进程 resolve 必须只在网关侧
    （`ApiKey [JsonIgnore]` 过 HTTP 会置空 → 二次 resolve 复活「选 A 给 B」，见 compute-then-send 规则）。
    须分批 CDS 编译验证 + 影子比对，失败即回滚。
  - 计费、数据库分离、调度算法重写：本轮明确不做（用户「计费暂缓」「数据库暂不分离避免表撕裂」）。
- **prd-llmgw-web 未上 CDS 预览**：仅后端 llmgw 上了预览（curl 可验）；前端独立站走 exec_dep / 后续 CDS
  集成（需处理 SPA base-path 路由）。当前前端可本地 `pnpm dev` 或 exec_dep 部署访问。
- **两个 LlmGateway 并存**：`prd-api/src/PrdAgent.LlmGateway`（阶段1 进程内 scaffold，api 引用）与
  顶层 `prd-llmgw`（独立观测进程）暂时并存，职责不同。波2 serving 落地时归并。
