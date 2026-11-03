import { Activity, ArrowRight, CheckCircle2, Copy, Image, Layers3, Link2, PenLine, ShieldCheck, SlidersHorizontal, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/design/Button';
import type { McpConsoleOverviewDto } from '@/services/contracts/mcpConsole';
import { toast } from '@/lib/toast';
import { capabilityVisual } from './capabilityRegistry';
import { copyToClipboard } from './clipboard';
import { clientSignal } from './signalEncoding';

export function McpSummaryRail({ overview, onCalls, onCapability, onSettings }: {
  overview: McpConsoleOverviewDto;
  onCalls: (status?: string) => void;
  onCapability: (key: string) => void;
  onSettings: () => void;
}) {
  const active = overview.clients.filter(client => client.isActive);
  const automatic = active.filter(client => client.scopeMode === 'auto').length;
  const signals = active.map(client => clientSignal(client, overview.capabilities));
  const { today } = overview;
  return <aside className="mcp-summary-rail lg:overflow-y-auto" aria-label="接入汇总" style={{ overscrollBehavior: 'contain' }}>
    <section className="mcp-rail-card">
      <h2><ShieldCheck size={15} aria-hidden />接入概览<span>{overview.clients.length} 个客户端</span></h2>
      <div className="mcp-rail-line"><span><CheckCircle2 size={13} aria-hidden />凭证可用</span><b>{active.length}<small> / {overview.clients.length}</small></b></div>
      <div className="mcp-mode-split"><span><ShieldCheck size={12} aria-hidden />自动授权 <b>{automatic}</b></span><span><SlidersHorizontal size={12} aria-hidden />自定义 <b>{active.length - automatic}</b></span></div>
      <p className="mcp-rail-note">按可用凭证统计，不代表客户端在线。</p>
    </section>
    <section className="mcp-rail-card">
      <h2><Activity size={15} aria-hidden />今日用量<span>UTC 自然日</span></h2>
      <button className="mcp-rail-line mcp-rail-link" onClick={() => onCalls()}><span><Activity size={13} aria-hidden />工具调用</span><b>{today.calls}<small> 次</small><ArrowRight size={12} aria-hidden /></b></button>
      <div className="mcp-rail-line"><span><Image size={13} aria-hidden />生成图片</span><b>{today.images}<small> 张</small></b></div>
      <div className="mcp-rail-line"><span><PenLine size={13} aria-hidden />写入操作</span><b>{today.writes}<small> 次</small></b></div>
      <div className="mcp-rail-results"><button onClick={() => onCalls('error')}><TriangleAlert size={12} aria-hidden />失败 <b>{today.failed}</b></button><button onClick={() => onCalls('denied')}><ShieldCheck size={12} aria-hidden />被拦截 <b>{today.denied}</b></button></div>
    </section>
    <section className="mcp-rail-card">
      <h2><Layers3 size={15} aria-hidden />能力覆盖<span>可用凭证</span></h2>
      <div className="mcp-coverage-list">{overview.capabilities.map(cap => {
        const visual = capabilityVisual(cap.key);
        const Icon = visual.icon;
        const count = signals.filter(signal => signal.dots.some(dot => dot.key === cap.key && dot.tier !== 'none')).length;
        return <button key={cap.key} className="mcp-coverage-row" aria-label={`筛选已授权${cap.title}的客户端`} onClick={() => onCapability(cap.key)}>
          <span className="mcp-coverage-icon" style={{ color: visual.text, background: visual.soft }}><Icon size={12} aria-hidden /></span><span>{cap.title}</span><span className="mcp-coverage-meter" aria-hidden><span style={{ width: `${active.length ? count / active.length * 100 : 0}%`, background: visual.text }} /></span><b>{count}<small> / {active.length}</small></b>
        </button>;
      })}</div>
      <p className="mcp-rail-note">点击能力可筛选已授权的客户端。</p>
    </section>
    <section className="mcp-rail-card">
      <h2><Link2 size={15} aria-hidden />连接地址</h2>
      <code className="mcp-rail-endpoint">{overview.endpointUrl}</code>
      <div className="mcp-rail-actions"><Button size="sm" onClick={async () => {
        if (await copyToClipboard(overview.endpointUrl)) toast.success('连接地址已复制');
        else toast.error('复制失败，请手动复制连接地址');
      }}><Copy size={12} aria-hidden />复制地址</Button><button onClick={onSettings}>配置与技能<ArrowRight size={12} aria-hidden /></button></div>
    </section>
  </aside>;
}
