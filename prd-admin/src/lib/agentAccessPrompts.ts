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

/** 文档空间（知识库）专用智能体指令 —— 真实端点，不引用 marketplace 技能 */
export function buildDocStoreAgentPrompt(key: string, options?: DocStorePromptOptions): string {
  const writable = options?.writable ?? true;
  const base = options?.base ?? (typeof window !== 'undefined' ? window.location.origin : '');
  const readLines = `- 列出我的知识库：GET  $PRD_AGENT_BASE/api/document-store/stores
- 读取某篇文章：  GET  $PRD_AGENT_BASE/api/document-store/entries/{entryId}`;
  const writeLines = `
- 新建知识库：    POST $PRD_AGENT_BASE/api/document-store/stores
- 在知识库下新增文章：POST $PRD_AGENT_BASE/api/document-store/stores/{storeId}/entries
- 更新文章正文：  PUT  $PRD_AGENT_BASE/api/document-store/entries/{entryId}/content`;

  return `请帮我接入 PrdAgent 知识库（文档空间）开放接口。

${buildKeySecretsBlock(key, base)}

③ 调用文档空间 API（统一带请求头 Authorization: Bearer $PRD_AGENT_API_KEY）：
${readLines}${writable ? writeLines : ''}

后续我说"把这份内容存进我的知识库"或"读一下我某个知识库的文章"，按上面的接口操作即可。
`;
}
