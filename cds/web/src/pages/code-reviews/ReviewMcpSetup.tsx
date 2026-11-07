import { useState } from 'react';
import { ArrowLeft, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ReviewCapabilities } from './ReviewComposer';

const configuration = JSON.stringify({ mcpServers: { 'cds-code-review': { command: 'node', args: ['/absolute/path/prd_agent/cds/mcp/src/server.mjs'] } } }, null, 2);
const toolLabels: Record<string, string> = {
  cds_code_review_submit: '提交 ZIP 或 GitHub 地址，返回任务 ID',
  cds_code_review_get: '读取进度、结构化问题、覆盖说明和报告链接',
  cds_code_review_list: '列出当前项目的审查记录',
  cds_code_review_report_upload: '保存已有 HTML / Markdown 报告，不重新审查',
};

export function ReviewMcpSetup({ capabilities, onBack }: { capabilities: ReviewCapabilities | null; onBack: () => void }): JSX.Element {
  const [copied, setCopied] = useState('');
  const copy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(configuration); setCopied('已复制，请替换为本机桥接路径。'); }
    catch { setCopied('复制未完成，请选中下方配置手动复制。'); }
  };
  return <section className="space-y-6"><Button variant="outline" onClick={onBack}><ArrowLeft />返回列表</Button>
    <div className="space-y-3"><h1 className="text-[1.75rem] font-semibold">让 AI 客户端直接使用代码审查</h1><p className="text-base text-muted-foreground">提交一次源码，按任务查询结果；同一份审查在 CDS 中继续阅读。</p></div>
    <div className="max-w-4xl space-y-4"><h2 className="text-base font-medium">1. 连接当前项目</h2><p className="text-base leading-6 text-muted-foreground">在待审项目中完成 CDS 连接；MCP 客户端的工作目录也设为该项目。项目凭据由连接流程保存，无需复制到配置中。</p>
      <h2 className="text-base font-medium">2. 将本地桥接加入 MCP 客户端</h2><p className="text-base text-muted-foreground">先在桥接所在的仓库安装依赖：</p><pre className="overflow-x-auto rounded-md bg-[hsl(var(--code-bg))] p-4 font-mono text-sm text-[hsl(var(--code-fg))]">pnpm --dir cds/mcp install --frozen-lockfile</pre>
      <div className="rounded-md bg-[hsl(var(--code-bg))] text-[hsl(var(--code-fg))]"><div className="flex justify-end p-2"><Button variant="ghost" onClick={() => { void copy(); }}><Copy />复制配置</Button></div><pre className="overflow-x-auto px-5 pb-5 font-mono text-sm leading-6">{configuration}</pre></div>
      <p role="status" className="text-sm text-muted-foreground">{copied || '把示例路径替换为本机路径；使用 Node 20.18.1 或更新版本。'}</p></div>
    <section className="space-y-3"><h2 className="text-base font-medium">可用工具</h2>{capabilities?.tools?.length ? <dl className="max-w-5xl divide-y divide-border">{capabilities.tools.filter(name => toolLabels[name]).map(name => <div key={name} className="grid gap-2 py-4 md:grid-cols-[22rem_minmax(0,1fr)]"><dt className="break-all font-mono text-sm">{name}</dt><dd className="text-base text-muted-foreground">{toolLabels[name]}</dd></div>)}</dl> : <p className="text-base text-muted-foreground">工具目录暂未读取成功，请返回列表刷新后重试。</p>}</section>
    <p className="text-base leading-6 text-muted-foreground">网页与 MCP 共用项目权限；默认归档到报告中心，仅主动填写邮箱时额外发送。查询工具只读取已有结果，不会重新执行审查。</p>
  </section>;
}
