/**
 * 智能体接入指令模板（SSOT）。
 *
 * 「接入 AI」签发长效 Key 后，会把一段"给智能体的完整指令"复制进剪贴板，
 * 用户粘贴到 Claude Code / Cursor，AI 照做即可自行完成配置。
 * 该文案被两处消费：
 *  1. 知识库入口 `pages/document-store/ConnectAiDialog.tsx`
 *  2. 海鲜市场入口 `pages/marketplace/skillOpenApi/CreateKeyTab.tsx`（document-store 分支）
 * 改指令措辞只动这一个文件，避免两处漂移。
 *
 * 安全考量（与 CreateKeyTab 历史实现一致）：
 *  - 明确要求"不要把 Key 写进仓库、Agent 本地设置、PR、验收报告或日志"
 *  - 默认写入本机 secrets 文件并 chmod 600；shell 里只临时读取
 *  - 不使用 ~/.env / .claude/settings.local.json / shell 启动文件这类容易被复制或提交的位置
 */

/** Key 安全保存 + 环境变量导入的公共段落 */
export function buildKeySecretsBlock(key: string, base: string): string {
  return `① 把 Key 保存到本机 secrets 文件。不要写进仓库、.claude/settings.local.json、PR、验收报告或公开日志：

mkdir -p ~/.codex/secrets
umask 077
printf '%s\\n' '${key}' > ~/.codex/secrets/prd-agent-api-key
chmod 600 ~/.codex/secrets/prd-agent-api-key

② 当前 shell 临时导入环境变量：

export PRD_AGENT_API_KEY="$(cat ~/.codex/secrets/prd-agent-api-key)"
export PRD_AGENT_BASE="${base}"`;
}

export interface DocStorePromptOptions {
  /** Key 是否含 document-store:write —— 决定指令里是否列出写入端点。默认 true */
  writable?: boolean;
  /** API 根地址，缺省取 window.location.origin */
  base?: string;
}

/**
 * 文档空间（知识库）专用智能体指令 —— 真实端点，不引用 marketplace 技能。
 *
 * 端点必须是 AgentApiKey（sk-ak-*）真正可用的开放接口 `/api/open/document-store/*`：
 * 普通业务路由 `/api/document-store/stores|entries` 在 AdminControllerScanner.PublicRoutes
 * 里（JWT 用户专用，跳过 scope→身份注入），sk-ak 没有 sub 会 401（PR #1166 Codex P1）。
 * 写入走受控发布协议 DocumentStorePublisherController（publisher + sourceId 幂等 upsert），
 * 开放接口不能新建知识库——库需在网页端先建好。
 */
export function buildDocStoreAgentPrompt(key: string, options?: DocStorePromptOptions): string {
  const writable = options?.writable ?? true;
  const base = options?.base ?? (typeof window !== 'undefined' ? window.location.origin : '');
  const readBlock = `③ 读取（统一带请求头 Authorization: Bearer $PRD_AGENT_API_KEY）：
- 列出我的知识库：GET  $PRD_AGENT_BASE/api/open/document-store/stores
- 列出库内文章：  GET  $PRD_AGENT_BASE/api/open/document-store/stores/{storeId}/entries
- 读取文章正文：  GET  $PRD_AGENT_BASE/api/open/document-store/entries/{entryId}/content`;
  const writeBlock = `

④ 写入走「受控发布」协议（同样 Bearer 鉴权）。注意：只能写我自己已有的知识库，开放接口不能新建库——目标库我会先在网页端建好：
- 查看发布快照：  GET    $PRD_AGENT_BASE/api/open/document-store/publisher/stores/{storeId}/snapshot?publisher={你的发布标识}
- 新增/更新文章： PUT    $PRD_AGENT_BASE/api/open/document-store/publisher/stores/{storeId}/nodes/{sourceId}
- 删除受管文章：  DELETE $PRD_AGENT_BASE/api/open/document-store/publisher/stores/{storeId}/nodes/{sourceId}（query 带 publisher/runId 及 expected* 校验参数，以快照返回值为准）

PUT body 必填字段：publisher（你固定的发布标识，小写字母/数字/点/下划线/短横线）、runId、kind（document 或 folder）、title、sourcePath、sourceRevision、sourceSha256（规范化正文的 SHA256）、manifestSha256、contentType（如 text/markdown）、content（正文）。
同一 publisher + sourceId 幂等 upsert，并发令牌规则（服务端强校验，弄错会 409）：
- 首次 PUT（新建该 sourceId）：不要带 expectedUpdatedAt / lastAppliedSha256；
- 更新已有 sourceId：必须先 GET snapshot，把该节点返回的 updatedAt 原样放进 body 的 expectedUpdatedAt 再 PUT。`;

  // 收尾指引按 Key 能力分支：只读 Key 不邀请"存进知识库"类请求（Key 无 write scope，
  // 照做只会 403 或诱导 AI 去试未授权路由）。
  const closing = writable
    ? '后续我说"把这份内容存进我的知识库"或"读一下我某个知识库的文章"，按上面的接口操作即可。'
    : '这把 Key 是只读的：后续我说"读一下我某个知识库的文章"之类的请求，按上面的接口操作即可；如果我要求写入或修改，请提醒我先签发带写入权限的 Key。';

  return `请帮我接入 PrdAgent 知识库（文档空间）开放接口。

${buildKeySecretsBlock(key, base)}

${readBlock}${writable ? writeBlock : ''}

${closing}
`;
}
