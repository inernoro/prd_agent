| feat | prd-api | 新增 MAP MCP 连接器网关（POST /api/mcp，Streamable HTTP）：把海鲜市场/知识库的开放接口翻译成 MCP 工具，可被 Claude/Codex 当连接器接入，复用 sk-ak + scope 鉴权，tools/call 回环转发到真实接口 |
| feat | prd-api | 新增 document-store 开放接口 DocumentStoreOpenApiController（/api/open/document-store，ApiKey+scope+boundUserId），让 MCP 知识库工具用 sk-ak 跑通（原 stores/entries 业务路由因 PublicRoutes 豁免无法注入 sk-ak 身份会 401） |
| fix | prd-api | MCP 网关处理 PR 二轮评审：协议版本回我方支持版本（不回声客户端任意版本）、回环地址解析补 `://*` 通配符 |
| fix | prd-api | MCP 动态工具 tools/call 替换 Path 中的 {param} 占位（原样转发会让路由参数原文漏到 loopback）；document-store 开放接口的 entries/content 也排除项目库/产品库/识途库专用库（与 stores 列表一致，防止知道 id 绕过） |
| fix | prd-api | MCP 端点路由由顶级 `/mcp` 改为 `/api/mcp`：CDS 反代只把 `/api/*` 转后端，顶级路径被前端 SPA 兜底接走导致 404/200-html 不可达；回环同时转发 X-AI-Access-Key fallback 鉴权头 |
| security | prd-api | MCP 回环 client 禁用自动重定向(AllowAutoRedirect=false):防回环目标返回跨主机重定向时把转发的 sk-ak/X-AI-Access-Key 凭据带到外部主机;回环异常信息改用 JsonObject 序列化防 ex.Message 破坏 JSON 信封 |
| test | prd-api | 新增 MCP 网关纯逻辑单测 McpGatewayLogicTests（工具目录/scope写隐含读/动态工具名唯一/路径占位替换/请求拼装/inputSchema 推断），不依赖 live 密钥即可断言行为 |
| feat | prd-api | AgentApiKeysController 增加 AiAccessKey 自助通道(全局超级密钥+X-AI-Impersonate 代用户签发 scoped sk-ak;归属校验+scope 白名单兜底),供 AI 无人值守自测开放接口 |
| fix | prd-api | MCP 回环转发 X-Client-Base-Url/X-Forwarded-Host/X-Forwarded-Proto,使下游 ResolveServerUrl 构造公网 URL 而非 localhost(影响海鲜市场 official skills 下载链接) |
| fix | prd-api | MCP 回环 client 禁用系统代理(UseProxy=false),防配了 HTTP_PROXY 的部署把携带 sk-ak 的回环请求发给代理 |
| docs | doc | 新增 guide.mcp-connector 接入教程(Claude/Codex 接入 + 5 工具 + 共享其他 Agent + 自助签发自测 + 排障) |
| fix | prd-api | MCP 回环 SendAsync 改用 CancellationToken.None(对齐 server-authority:客户端瞬断不取消下游长任务,120s 超时兜底) |
| fix | prd-api | MCP 网关非抛出式读取 method/name(畸形如 "method":1 返回 -32600 而非 500),加 AsString 单测 |
