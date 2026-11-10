import { useState } from 'react';
import { Copy } from 'lucide-react';
import type { ReviewCapabilities } from './ReviewComposer';
import { ReviewBack, ReviewButton } from './ReviewUi';

const configuration = JSON.stringify({ mcpServers: { 'cds-code-review': { command: 'node', args: ['/absolute/path/prd_agent/cds/mcp/src/server.mjs'] } } }, null, 2);
const toolLabels: Record<string, string> = {
  cds_code_review_list: '列出当前项目的任务；includeBranches=true 同时查询已登记分支',
  cds_code_review_submit: '提交 ZIP / GitHub 地址，或选择平台项目分支发起审查',
  cds_code_review_get: '查询状态、覆盖范围和已保存的问题；不会触发重新扫描',
  cds_code_review_report_upload: '上传已有 HTML / Markdown 报告，不启动源码审查',
};
export function ReviewMcpSetup({ capabilities, onBack }: { capabilities: ReviewCapabilities | null; onBack: () => void }): JSX.Element {
  const [copied, setCopied] = useState('');
  const copy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(configuration); setCopied('已复制，请将桥接路径替换为本机路径。'); }
    catch { setCopied('复制未完成，请手动选择下方配置文本。'); }
  };
  return <section className="cr-stack"><ReviewBack onBack={onBack} /><div><h1>MCP 接入</h1><p className="cr-subtitle">在本地 AI 客户端中通过 MCP 使用代码审查。网页与客户端读取同一份任务，使用同一套项目权限。</p></div>
    <div className="cr-mcp-grid"><div>
      <section className="cr-onboarding"><span className="cr-onboarding-number">1</span><div className="cr-onboarding-body"><h2>连接当前项目</h2><p>在待审项目中完成 CDS 连接，并将 MCP 客户端的工作目录设为该项目。</p><div className="cr-notice">项目范围由工作目录中的 <code className="cr-mono">.cds/credentials.json</code> 决定，沿用项目级凭据。配置中无需填写密钥。</div></div></section>
      <section className="cr-onboarding"><span className="cr-onboarding-number">2</span><div className="cr-onboarding-body"><div className="cr-row-inline"><h2>复制本地桥接配置</h2><ReviewButton tone="ghost" className="cr-end" onClick={() => { void copy(); }}><Copy />复制配置</ReviewButton></div><pre className="cr-code">{configuration}</pre><p role="status">{copied || '将示例路径替换为项目仓库中 cds/mcp/src/server.mjs 的本机绝对路径。'}</p><p>安装桥接依赖（Node 20.18.1 或更新版本，替换为本机仓库路径）：</p><pre className="cr-code">pnpm --dir /absolute/path/prd_agent/cds/mcp install --frozen-lockfile</pre><p>加入客户端配置后重启客户端。桥接在本机读取文件，再上传到当前凭据绑定的项目。</p><details className="cr-form-note"><summary>Codex 客户端的工作目录配置</summary><pre className="cr-code">{'[mcp_servers.cds-code-review]\ncommand = "node"\nargs = ["/absolute/path/prd_agent/cds/mcp/src/server.mjs"]\ncwd = "/absolute/path/project"'}</pre></details></div></section>
      <section className="cr-onboarding"><span className="cr-onboarding-number">3</span><div className="cr-onboarding-body"><h2>发现工具</h2><p>重启后，客户端会列出当前 CDS 已注册的工具：</p>{capabilities?.tools?.length ? <div className="cr-surface"><table className="cr-tool-table"><thead><tr><th>工具</th><th>用途</th></tr></thead><tbody>{capabilities.tools.filter(name => toolLabels[name]).map(name => <tr key={name}><td>{name}</td><td>{toolLabels[name]}</td></tr>)}</tbody></table></div> : <p>工具目录尚未读取成功，请使用顶部刷新后重试。</p>}<p>直接审查平台分支：先查询分支，再将所选 branchId 交给提交工具。查询已有结果不会恢复收费分析。</p></div></section>
    </div><aside className="cr-surface cr-help"><h2>同一任务，两处可读</h2><p>客户端发起的任务会出现在审查列表中，网页里同样可以查看进度、阅读结果和取消。</p><h2>当前能力</h2><p>本地 stdio 桥接、项目权限、ZIP / GitHub / 平台分支审查与已有报告上传。</p><p>源码默认归档报告中心；显式提供邮箱时才额外发送。邮件失败与审查重试分开处理。</p></aside></div>
  </section>;
}
