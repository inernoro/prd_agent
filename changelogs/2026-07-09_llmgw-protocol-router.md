| feat | prd-api | LLM Gateway serving 新增 Claude/Gemini 兼容入口、GW Request IR 上下文字段与 appCaller 被动登记 |
| feat | prd-api | LLM Gateway serving 按 appCaller 注册表的每分钟限流配置拦截真实发送入口，超限返回 429 |
| feat | prd-api | LLM Gateway serving 新增 appCaller 月预算门，按已有 GW 日志成本字段累计本月花费并在超额时返回 429 |
| feat | prd-api | LLM Gateway 日志新增模型池价格快照与 EstimatedCost 成本归因字段，用于后续预算和成本观测 |
| feat | prd-api | LLM Gateway 日志新增 ProviderAttempts 快照，记录最终发送尝试、fallback 前原池候选和完成结果字段 |
| feat | prd-api | Exchange async raw 路径将 submit、poll 和 poll-timeout 逐次写入 ProviderAttempts |
| feat | prd-api | 非流式 auto 模式支持 402、408、429 和 5xx 等可重试失败后切换下一个已解析 provider 候选 |
| feat | prd-api | 模型池成员价格快照新增 PriceCurrency，USD 成本可写入 EstimatedCostUsd 参与月预算统计 |
| feat | prd-api | ModelResolver 优先消费 GW active appCaller 模型池绑定，未激活时保持 MAP 旧配置兜底 |
| feat | prd-api | ModelResolver 命中 active appCaller 时优先读取 llm_gateway 自有模型池，缺失再回退 MAP 模型池 |
| feat | prd-api | ModelResolver 解析平台、模型与 Exchange 时优先读取 llm_gateway 自有配置，缺失再回退 MAP 配置 |
| feat | prd-api | ModelResolver 新增 active appCaller MAP fallback 退场门，开启后仅允许 GW-owned 池、平台与 Exchange |
| feat | prd-api | ModelResolver 池路径读取成员 function_calling 能力快照，带 tools 请求可复用现有能力软门 |
| feat | prd-api | Gateway 发送前校验 vision、image_generation 与 thinking 能力，模型明确不支持时本地熔断 |
| feat | prd-api | Claude/Gemini 兼容入口记录适配器丢弃参数，为后续严格参数策略提供观测基础 |
| feat | prd-api | LLM 请求日志新增参数策略与 dropped 参数字段，串起入口适配观测链路 |
| feat | prd-api | LLM Gateway 流式 auto 模式支持输出前可重试失败后切换下一个已解析 provider 候选 |
| feat | prd-api | LLM Gateway raw JSON/multipart submit 阶段支持可重试失败后切换下一个已解析 provider 候选 |
| feat | prd-api | LLM Gateway 成功完成日志会把 provider、model、平台和模型池根字段更新为最终发送候选 |
| ops | scripts | LLM Gateway release gate 新增配置权威检查，http-full 台账拒绝缺少 configAuthority.ok 的全量切换证据 |
| feat | prd-llmgw | 新增 GW appCaller 注册表只读与状态/模型池/策略写入接口 |
| feat | prd-llmgw | appCaller 注册表支持维护 owner、月预算和每分钟限流治理元数据，并纳入操作审计 |
| feat | prd-llmgw | 支持将 MAP 模型池认领到 llm_gateway 自有模型池集合，并在模型池列表标注权威来源 |
| feat | prd-llmgw | 支持直接新建 GW 权威模型池，并批量认领 MAP 模型池到 llm_gateway |
| feat | prd-llmgw | 支持编辑 GW 权威模型池名称、Code、类型、优先级、策略和描述，MAP 来源池需先认领 |
| feat | prd-llmgw | 为 GW 权威模型池新增成员添加、删除和优先级更新接口，写入仅限 llm_gateway 自有集合 |
| feat | prd-llmgw | 模型池成员保存时记录模型能力快照，用于后续 router 能力过滤与控制台解释 |
| feat | prd-llmgw | 新增配置权威迁移只读报告，量化 MAP-only 配置与 active appCaller 缺 GW 池问题 |
| feat | prd-llmgw | 配置权威迁移报告新增 MAP fallback 剩余对象数与 active fallback readiness 字段 |
| feat | prd-llmgw | 新增配置权威统一批量认领接口，可将 MAP-only 池、平台、模型与 Exchange 复制到 llm_gateway |
| feat | prd-llmgw | 新增 active appCaller 绑定 GW 默认池接口，用于消除删除 MAP fallback 前的调用方缺口 |
| feat | prd-llmgw | 支持将 MAP 平台、模型与 Exchange 认领到 llm_gateway 自有配置集合，已认领配置的启停写回 GW 集合 |
| feat | prd-llmgw | 新增 Exchange 只读列表接口，展示 transformer、目标地址、模型条目与密钥配置状态 |
| security | prd-llmgw | 为 GW-owned 平台、模型与 Exchange 增加 API key 轮换端点，密钥只写加密字段且审计不记录明文 |
| security | prd-llmgw | 新增 GW-owned API key 解密健康自检端点，只返回状态与计数，不返回明文或密文 |
| ops | prd-llmgw | 为 llmgw 控制台容器注入与 api/llmgw-serve 一致的 ApiKeyCrypto__Secret，保证 GW 写入密文可被 serving 解密 |
| feat | prd-llmgw | 日志详情接口返回参数策略与 dropped 参数 |
| feat | prd-llmgw-web | 新增调用方注册表页面、导航入口、行内配置保存、模型池/平台认领入口和日志详情参数策略展示 |
| feat | prd-llmgw-web | 调用方注册表页面新增 owner、月预算和 RPM 输入，支持在 GW 控制台维护 caller 治理元数据 |
| feat | prd-llmgw-web | 模型池页面新增 GW 池创建工具条与 MAP 池批量认领入口 |
| feat | prd-llmgw-web | 模型池页面新增 GW 权威池属性编辑态，可保存名称、Code、类型、优先级、策略和描述 |
| feat | prd-llmgw-web | 模型池页面支持在 GW 权威池内添加、移除模型并保存池内优先级 |
| feat | prd-llmgw-web | 模型池页面新增候选模型能力过滤和池成员能力标签，减少跨类型误配 |
| feat | prd-llmgw-web | 模型池页面新增 structured output 候选过滤和标签，便于为 JSON schema 请求配置正确模型 |
| feat | prd-llmgw-web | 模型池页面新增 logprobs 候选过滤和标签，便于为 token 概率请求配置正确模型 |
| feat | prd-llmgw-web | 模型池页面新增 parallel tools 候选过滤和标签，便于为并行工具调用请求配置正确模型 |
| feat | prd-llmgw-web | 概览页新增配置权威迁移卡片，展示 readiness 百分比与 MAP fallback 退场缺口 |
| feat | prd-llmgw-web | 概览页权威迁移卡片新增 active fallback 可关闭状态提示 |
| feat | prd-llmgw-web | 概览页新增 MAP-only 配置批量认领按钮，执行后刷新权威迁移状态 |
| feat | prd-llmgw-web | 概览页新增 active 调用方绑定按钮，按 requestType 绑定同类型 GW 默认池 |
| feat | prd-llmgw-web | 新增模型与 Exchange 控制台页面，支持查看权威来源并认领 MAP 配置到 GW |
| security | prd-llmgw-web | 在平台、模型与 Exchange 页面为 GW 权威对象提供内联密钥更新入口，保存后不保留明文 |
| security | prd-llmgw-web | 概览页新增 GW-owned 密钥自检卡片，展示可解、不可解、缺省与 legacy 状态 |
| feat | prd-api | LLM Gateway serving 新增 OpenAI-compatible `/v1/responses` 与 `/v1/images/generations` 基础入口，统一进入 GW IR、密钥门和路由日志 |
| feat | prd-api | OpenAI-compatible `/v1/responses` 非流式响应保留 Gateway tool calls，输出 Responses 风格 function_call 项 |
| feat | prd-api | OpenAI-compatible `/v1/responses` 流式响应保留 Gateway tool call chunk，输出 Responses function_call SSE 事件 |
| feat | prd-api | OpenAI-compatible `/v1/responses` 检测 input_image 请求并改走 vision requestType 与开放接口 vision appCaller |
| feat | prd-api | Claude-compatible `/v1/messages` 非流式响应保留 Gateway tool calls，输出 Anthropic tool_use content |
| feat | prd-api | Claude-compatible `/v1/messages` 流式响应保留 Gateway tool call chunk，输出 Anthropic tool_use SSE 事件 |
| feat | prd-api | Gemini-compatible `generateContent` 支持 functionDeclarations/toolConfig 转统一 tools，并将 Gateway tool call 响应转回 Gemini functionCall |
| feat | prd-api | Gemini-compatible 新增 `streamGenerateContent` 基础 SSE 入口，并保留 functionCall/functionResponse 与统一 tool_calls/tool result 的双向映射 |
| feat | prd-api | Gemini Native transformer 支持统一 tools/tool_choice、assistant tool_calls、tool result 与 Gemini functionDeclarations/functionCall/functionResponse 的往返转换 |
| feat | prd-api | `strict-require` 参数策略对 function_calling、vision、image_generation、thinking 已模型化能力执行未知即拒绝的 router 门 |
| feat | prd-api | `strict-require` 参数策略在入口适配器发现 droppedParameters 时直接拒绝，并在 GW native/raw/send/stream 路径兜底拦截 |
| feat | prd-api | `strict-require` 参数策略新增 structured_output/json_schema 能力门，结构化输出请求在未知或不支持模型上发 HTTP 前拒绝 |
| feat | prd-api | `strict-require` 参数策略新增 logprobs/top_logprobs 能力门，并在 OpenAI-compatible chat/Responses 入口保留相关参数 |
| feat | prd-api | `strict-require` 参数策略新增 parallel_tool_calls 能力门，并在 OpenAI-compatible chat/Responses 入口保留并行工具调用参数 |
| feat | prd-api | LLM Gateway 新增第一批 `parameter:<name>` 字段级参数能力矩阵，strict-require 下对 seed、stop、penalty、modalities 等参数做模型能力校验 |
| feat | prd-llmgw | 模型池成员 upsert 支持 capabilities 覆盖层，可在 GW 权威池中保存字段级参数能力 |
| feat | prd-llmgw | 新增字段级参数能力元数据接口，控制台可读取第一批受管 `parameter:<name>` 清单 |
| feat | prd-llmgw | 字段级参数能力元数据新增 OpenAI、Claude、Gemini 与 OpenRouter 模板，支持控制台一键填充 provider 参数能力 |
| feat | prd-llmgw | 日志列表、详情和 summary API 返回 EstimatedCost 成本字段，支持控制台成本观测 |
| feat | prd-llmgw | 日志详情 API 新增 routerTrace 派生对象，展示 route mode、模型池、平台、实际模型、fallback 与参数策略 |
| feat | prd-llmgw | 日志详情 API 返回 ProviderAttempts，并补齐 statusCode、durationMs、error、endedAt 结果字段 |
| feat | prd-llmgw | GW 模型池成员 upsert 支持 PriceCurrency，限制为 CNY 或 USD 并随池成员返回 |
| feat | prd-llmgw | 新增 GW 权威模型池成员批量导入接口，可按平台、启用态和能力过滤从 GW/MAP 模型清单生成成员快照 |
| feat | prd-llmgw | 新增 GW-owned 模型能力矩阵批量维护接口，可按平台或显式全量范围合并写入模型能力 |
| feat | prd-llmgw | appCaller 注册表新增按筛选批量治理接口，可批量设置 owner、USD 月预算、RPM、状态和策略并写操作审计 |
| feat | prd-llmgw | 新增 GW 操作审计只读筛选接口，可按 action、targetType、actor、success、搜索和时间窗口查询审计记录 |
| feat | prd-llmgw | 新增 GW 权威模型池成员价格币种批量校准接口，默认只补已有价格但币种为空的历史成员 |
| security | prd-llmgw | 新增 GW-owned 平台、模型与 Exchange 密钥删除端点，只清理 llm_gateway 自有密文字段并写操作审计 |
| security | prd-llmgw | 新增 GW-owned 平台、模型与 Exchange 批量密钥轮换端点，要求显式范围并只写 llm_gateway 自有集合 |
| feat | prd-llmgw-web | 模型池页面新增 Parameters 过滤和字段级参数能力输入，可维护 `parameter:<name>` 能力快照 |
| feat | prd-llmgw-web | 模型池成员编辑接入字段级参数能力元数据提示，减少手输参数名漂移 |
| feat | prd-api | LLM Gateway serving 新增 OpenAI-compatible `/v1/images/edits` multipart 入口，图片编辑请求经 GW raw multipart 路由发送 |
| feat | prd-llmgw-web | GW 日志列表、详情抽屉和 summary 接入 EstimatedCost 成本展示，缺价格快照时保持缺省值 |
| feat | prd-llmgw-web | 日志详情抽屉新增 Router trace 区块，集中解释请求路由、模型池、平台、transport 与 dropped 参数 |
| feat | prd-llmgw-web | 日志详情抽屉新增 Provider attempts 列表，展示候选、发送、HTTP 状态、耗时、transport 和失败原因 |
| feat | prd-llmgw-web | GW 模型池成员行新增价格币种选择，可为成员设置 CNY 或 USD |
| feat | prd-llmgw-web | 模型池页面新增批量导入成员工具，可按平台和能力过滤将候选模型导入 GW 权威池 |
| feat | prd-llmgw-web | 模型页面新增批量维护能力工具，可向当前筛选的 GW 模型写入 vision、tool、parameter 等能力标记 |
| feat | prd-llmgw-web | 模型页面批量能力维护支持选择 provider 参数模板并合并到能力输入框 |
| feat | prd-llmgw-web | appCaller 注册表页面新增按当前筛选批量治理工具条，支持批量维护 owner、USD 月预算、RPM、状态和策略 |
| feat | prd-llmgw-web | 新增操作审计页面和导航入口，用于追溯 GW 控制台配置动作与变更摘要 |
| feat | prd-llmgw-web | 模型池页面新增价格币种批量校准工具，可按类型将历史成员补齐为 CNY 或 USD |
| security | prd-llmgw-web | 平台、模型与 Exchange 页面新增清除密钥按钮，支持删除 GW 权威对象的密钥配置 |
| security | prd-llmgw-web | 平台、模型与 Exchange 页面新增批量轮换密钥工具条，操作前需确认 GW 权威范围 |
| test | prd-api | 补充 LLM Gateway 多入口密钥门、兼容响应合同与 GW registry 路由守卫测试 |
| test | prd-api | 补充 appCaller 批量治理端点、审计动作和控制台入口守卫 |
| test | prd-api | 补充 GW 操作审计筛选 API 与控制台审计页守卫 |
| test | prd-api | 补充 GW 模型池成员批量导入 API、审计动作和控制台入口守卫 |
| test | prd-api | 补充 GW-owned 模型能力矩阵批量维护 API 和控制台入口守卫 |
| test | prd-api | 补充 provider 参数能力模板元数据和模型页模板入口守卫 |
| test | prd-api | 补充 active appCaller MAP fallback 退场门和控制台报告字段守卫 |
| test | prd-api | 补充日志详情 routerTrace DTO、后端派生函数和详情抽屉展示守卫 |
| test | prd-api | 补充 ProviderAttempts 日志写入、结果字段、控制台详情映射和前端 attempts 展示守卫 |
| test | prd-api | 补充 Exchange async raw ProviderAttempts submit/poll 记录守卫 |
| test | prd-api | 补充非流式 auto provider retry 行为测试，断言第二候选被调用并写入 attempts |
| test | prd-api | 补充流式 auto provider retry 行为测试，断言输出前失败不透出且第二候选成功返回 SSE |
| test | prd-api | 补充 raw auto provider retry 行为测试，断言第二候选被调用并写入 attempts |
| test | prd-api | 补充 release gate 与 rollout ledger 配置权威门禁静态守卫 |
| ops | scripts | 新增 LLM Gateway 配置权威退场脚本，默认只读并支持显式执行 bulk-claim、active appCaller 绑池和 readiness 留证 |
| test | prd-api | 补充配置权威退场脚本 dry-run、execute、require-ready 与发布树关键路径守卫 |
| ops | scripts | 新增 config-authority 生产阶段，配置权威退场可进入 rollout ledger 且不触发 fast.sh/exec_dep.sh |
| ci | github-actions | LLM Gateway 生产阶段 workflow 新增 config-authority 选项和控制台凭据注入 |
| ops | scripts | 将 config-authority 阶段前移到 canary 之前，避免视频/ASR 暂缓阻塞 GW 配置权威迁移 |
| ops | scripts | config-authority 阶段从 rollout 观察窗口中排除，不额外制造 24 小时等待 |
| ops | scripts | config-authority 阶段新增生产本机 Mongo 备份脚本，写库前备份 llm_gateway 与 MAP 模型配置关键集合 |
| test | prd-api | 补充 config-authority 备份先行、ledger 备份证据和 readiness 静态守卫 |
| docs | assets | 将 LLM Gateway 架构 HTML 和绘制 brief 从当前态改写为目标协议路由架构 |
| test | prd-api | 补充四类协议入口和 GW Native 必须经过 IR、appCaller 被动注册与治理路径的静态守卫 |
| ops | scripts | 新增协议路由目标审计脚本，输出入口协议、IR、appCaller、配置权威、控制台和发布证据进度报告 |
| ops | scripts | readiness audit 默认接入协议路由目标审计，发布前自动汇报目标架构进度证据 |
| ops | scripts | 协议路由目标审计明确区分静态证据与运行态完成，并列出生产 config-authority、fallback 退场和 http-full 剩余门槛 |
| ops | scripts | readiness audit 解析协议路由审计 JSON，将 targetComplete 与 remainingRuntimeGates 写入发布前详情 |
| ops | scripts | 生产 stage runner 固定输出协议路由目标审计 JSON/Markdown 到 rollout evidence artifact |
| test | prd-api | 补充生产 stage 协议路由审计证据路径、dry-run 字段和执行顺序守卫 |
| ops | scripts | rollout ledger 新增协议路由审计证据字段，成功 stage 追加前需校验审计 JSON |
| test | prd-api | 补充 rollout ledger 协议路由审计字段、parser 和 targetComplete 语义守卫 |
| ops | scripts | config-authority 操作脚本新增本地 self-test，readiness 默认验证配置权威 ready/fail 判定逻辑 |
| test | prd-api | 补充 config-authority self-test、未改密账号拦截和 readiness 接入守卫 |
| ops | scripts | 协议路由目标审计新增 rollout ledger 协议审计证据链检查 |
| test | prd-api | 补充 protocol-router audit 对 ledger 协议审计字段的守卫 |
| ops | scripts | http-full 生产阶段默认开启 active appCaller MAP fallback 退场门，并在 stage/ledger 证据中记录 |
| ops | docker | API compose 新增 LlmGateway__DisableMapConfigFallbackForActiveAppCallers 配置透传，生产和 CDS 默认 false |
| test | prd-api | 补充 MAP fallback 退场门发布开关、compose 透传和协议审计覆盖守卫 |
| test | prd-api | 补充模型池价格币种批量校准 API 与控制台入口守卫 |
| test | prd-api | 补充 GW-owned 密钥删除端点和控制台入口守卫 |
| test | prd-api | 补充 GW-owned 批量密钥轮换端点、审计动作和控制台入口守卫 |
| ops | scripts | rollback 和 restore-shadow 明确清理 active appCaller MAP fallback 退场门，避免 full-http 回滚后残留 |
| test | prd-api | 补充 rollback/restore dry-run 与 env 持久化对 MAP fallback 退场门清理的守卫 |
| ops | scripts | rollout ledger 强制 http-full success 必须启用 active appCaller MAP fallback 退场门 |
| test | prd-api | 补充 http-full 禁用 fallback 退场门时 stage-report 必须失败的 readiness 自测和静态守卫 |
| feat | prd-api | GW 兼容入口支持 X-Gateway-Model-Policy 与 provider.model_policy，将 pool 策略写入 IR 与日志上下文 |
| test | prd-api | 补充 OpenAI、Claude、Gemini 和 GW Native 保留 pool modelPolicy 的 serving 契约测试 |
| feat | prd-api | GW 兼容入口支持 X-Gateway-Model-Pool-Id 与 modelPoolId/model_pool_id，把 pool 模式精确落到指定 GW 模型池 |
| test | prd-api | 补充 ModelResolver 按模型池 Id 命中 pool 策略的单元测试和协议路由静态守卫 |
| docs | doc | 更新 LLM Gateway 协议路由计划，明确 pool 模式的 ModelPoolId 表达方式和 GW 模型池匹配规则 |
| feat | prd-api | GW 兼容入口支持 X-Gateway-Pinned-Platform-Id 与 X-Gateway-Pinned-Model-Id，并接收 body/provider metadata 的 pinned platform/model 字段 |
| test | prd-api | 补充 OpenAI 与 Gemini 兼容入口 pinned platform/model 透传契约测试和协议路由静态守卫 |
| docs | doc | 更新 LLM Gateway 协议路由计划，明确 pinned 模式在 GW Native、OpenAI、Claude 与 Gemini 入口的表达方式 |
| test | prd-api | 补充 Claude 兼容入口、Images JSON raw 和 Images multipart raw 的 pinned platform/model 透传契约测试 |
| ops | scripts | gw-smoke 新增可选 route matrix，通过 /gw/v1/resolve 验证 auto、pool、pinned 路由策略进入 GW router |
| test | prd-api | 补充 gw-smoke route matrix 环境变量、/resolve 用例、self-test 和 auto/pool/pinned 行的静态守卫 |
| ci | github-actions | LLM Gateway 生产阶段 workflow 新增 route matrix 输入，可把 auto、pool、pinned 低成本路由证据纳入发布 stage |
| ops | scripts | 生产 stage runner 透传 gw-smoke route matrix 参数，启用时强制要求 pool 与 pinned 目标完整 |
| ops | scripts | rollout ledger 新增 smokeRouteMatrixRequired 证据字段，后续 audit 会拒绝缺失、失败或 skipped 的 route matrix 行 |
| docs | doc | 更新 LLM Gateway 发布计划，说明 route matrix 在 readiness、workflow、stage 与 ledger 中的使用方式 |
| feat | prd-api | OpenAI Images edits 兼容入口支持 `image[]` 与 `image[n]` 多图 multipart 字段规范化，进入 GW raw 时保留多张参考图 |
| test | prd-api | 补充 Images edits 多图入口契约测试和 raw multipart 发送字段名规范化测试 |
| docs | doc | 更新 LLM Gateway 协议路由计划，标注 Images edits multipart 多图字段已覆盖 |
| feat | prd-api | Claude-compatible Messages image block 转统一 `image_url`，并按 vision requestType 与 appCaller 路由 |
| feat | prd-api | Gemini-compatible inlineData 图片请求按 vision requestType 与 appCaller 路由，避免走 chat 默认池 |
| test | prd-api | 补充 Claude image block 与 Gemini inlineData 的 vision 路由契约测试和协议入口静态守卫 |
| feat | prd-api | Claude-compatible Messages 支持 URL image source 转统一 `image_url` 并按 vision 路由 |
| feat | prd-api | Gemini-compatible fileData 图片请求转统一 `image_url` 并按 vision 路由 |
| test | prd-api | 补充 Claude URL source 与 Gemini fileData 的 vision 路由契约测试 |
| feat | prd-api | OpenAI Responses input_image 转换保留 detail 参数，避免 vision 入口丢失分辨率提示 |
| test | prd-api | 补充 OpenAI Responses vision detail 参数保真断言和协议入口静态守卫 |
| feat | prd-api | GW 请求日志落库补齐 sourceSystem、ingressProtocol、appCallerTitle、modelPolicy 与 modelPoolId，支持控制台解释协议入口和路由策略 |
| polish | prd-llmgw-web | 日志详情抽屉新增 Source、Ingress、Policy、Requested pool 和入口元数据展示，打开单条日志即可解释本次路由 |
| test | prd-api | 补充 GW 日志入口上下文从请求到控制台详情的行为测试和静态守卫 |
| feat | prd-llmgw | 日志列表、summary、timeseries 和 sessions 支持按 sourceSystem、ingressProtocol、modelPolicy 统一过滤 |
| polish | prd-llmgw-web | LogsView 筛选条新增 Source、Ingress、Policy 下拉项，用于定位协议入口和路由策略问题 |
| test | prd-api | 补充日志入口协议与模型策略筛选链路的静态守卫 |
| feat | prd-api | GW appCaller 被动注册首次写入模型策略建议，并持续记录 last observed 路由与参数策略，不覆盖管理员配置 |
| polish | prd-llmgw-web | appCaller 注册表页面显示最近请求观察到的路由策略和参数策略，便于对比配置与真实入口行为 |
| test | prd-api | 补充 appCaller 注册表配置字段与 last observed 字段分离的静态守卫 |
| feat | prd-llmgw | appCaller 注册表支持 route、parameter、any drift 筛选，并让批量治理沿用同一筛选口径 |
| polish | prd-llmgw-web | appCaller 注册表新增漂移筛选和路由/参数漂移标识，便于收敛配置权威 |
| feat | prd-llmgw | 新增 `/gw/runtime-gates` 只读发布 gate 聚合，汇总配置权威、active 绑池、shadow/http、rollout ledger 与 legacy 清理窗口 |
| polish | prd-llmgw-web | Overview 第一屏新增发布 Gate 面板，直接说明 full-http 当前阻塞、等待和保留项 |
| feat | prd-llmgw | runtime gate 读取可配置 rollout ledger，并要求同 commit 的 http-full success、release gate 和 MAP fallback 退场证据 |
| feat | prd-llmgw | runtime gate 新增 config-authority 台账校验，要求同 commit 的备份证据与配置权威执行证据 |
| ops | docker | 为 llmgw 控制台挂载 rollout ledger 证据目录并显式配置读取路径，确保 runtime-gates 能读取生产台账 |
| feat | prd-llmgw | shadow runtime gate 仅统计当前 GIT_COMMIT 的 shadow comparison，避免旧版本样本误放行 full-http |
| feat | prd-llmgw | runtime gate 新增 GW 密钥完整性校验，阻塞不可解、legacy、开发桩不可解和启用平台/Exchange 缺 key |
| feat | prd-llmgw | runtime gate 新增 appCaller 策略漂移校验，阻塞 active/configured 调用方路由或参数策略与最近请求不一致 |
| feat | prd-llmgw | runtime gate 新增 GW 池成员可用性校验，阻塞 active 调用方绑定到空池或无可解析成员的池 |
| feat | prd-api | LLM 请求日志新增 ReleaseCommit，用于发布 gate 按同一 commit 追溯运行证据 |
| feat | prd-llmgw | runtime gate 新增当前 commit 参数丢弃证据校验，并支持 `/gw/logs?releaseCommit=` 回查 |
| feat | prd-llmgw | runtime gate 新增 active appCaller 当前 commit 覆盖校验，要求每个调用方都有日志或 shadow 样本 |
| feat | scripts | release gate 新增 `--require-runtime-gates` 并在 full-http post-deploy 阶段强制校验 `/gw/runtime-gates` |
| feat | scripts | `exec_dep.sh` 在 `LLMGW_MODE=http` 时默认要求 GW config-authority 报告，避免绕过配置权威退场门 |
| test | scripts | release gate 新增 `--self-test` 离线验证 runtime-gates pass/fail 解析逻辑，并接入 readiness audit |
| feat | prd-llmgw | runtime gate item 新增结构化 facts，并在 release gate 证据中保留 blocking gate facts |
| ops | scripts | `http-full` 生产阶段提前校验 GW 控制台 base 与凭据，避免后置 runtime gate 读取失败 |
| ops | scripts | full-http post-deploy runtime gate 校验新增 releaseCommit 比对，防止跨 commit 控制台证据误放行 |
| polish | prd-llmgw | 台账类 runtime gate facts 补齐 rolloutLedger、currentCommit、latestCommit、recordedAt、missing 与证据布尔字段 |
| polish | prd-llmgw-web | 发布 Gate 面板优先展示 sameCommit、missing、证据文件布尔字段，避免台账阻塞原因被普通 facts 截断 |
| feat | prd-llmgw | runtime gate 新增 active_appcaller_map_fallback_exit，要求当前运行态真实启用 active appCaller 禁止 MAP fallback 开关 |
| polish | prd-llmgw-web | 发布 Gate 面板为 active_appcaller_map_fallback_exit 优先展示退场开关和 active appCaller 绑池事实 |
| feat | prd-llmgw | runtime gate 新增 current_commit_http_transport，要求当前 commit 的 LLM 日志全部为 GatewayTransport=http |
| polish | prd-llmgw-web | 发布 Gate 面板为 current_commit_http_transport 优先展示 http 与非 http 日志数量 |
| test | scripts | release gate 自测覆盖 current_commit_http_transport，并断言 nonHttpTransportLogs facts 不丢失 |
| test | scripts | release gate 自测新增 Markdown 报告检查，确保阻塞 runtime gate facts 会进入人工可读报告 |
| docs | doc | 明确 /gw/v1/resolve route matrix 只证明路由解析，不计入 appCaller runtime coverage 或 transport/参数运行态 gate |
| test | prd-api | 补充 /gw/v1/resolve 证据边界守卫，防止把路由解析样本误当成真实请求日志证据 |
