| feat | prd-api | 新增 MAP MCP 连接器网关（POST /mcp，Streamable HTTP）：把海鲜市场/知识库的开放接口翻译成 MCP 工具，可被 Claude/Codex 当连接器接入，复用 sk-ak + scope 鉴权，tools/call 回环转发到真实接口 |
| feat | prd-api | 新增 document-store 开放接口 DocumentStoreOpenApiController（/api/open/document-store，ApiKey+scope+boundUserId），让 MCP 知识库工具用 sk-ak 跑通（原 stores/entries 业务路由因 PublicRoutes 豁免无法注入 sk-ak 身份会 401） |
| fix | prd-api | MCP 网关处理 PR 二轮评审：协议版本回我方支持版本（不回声客户端任意版本）、回环地址解析补 `://*` 通配符 |
| fix | prd-api | MCP 动态工具 tools/call 替换 Path 中的 {param} 占位（原样转发会让路由参数原文漏到 loopback）；document-store 开放接口的 entries/content 也排除项目库/产品库/识途库专用库（与 stores 列表一致，防止知道 id 绕过） |
