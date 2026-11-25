/* 只用于原型：发布后落到网页托管、从百宝箱进入。正式实现分别是 WebPagesPage（?focusSite= 已支持定位高亮）与百宝箱。 */
import { useNavigate } from 'react-router-dom';
import { Check, Clapperboard, Copy, ExternalLink, Film, Globe, Library, Share2 } from 'lucide-react';
import { Badge } from '@/components/design/Badge';
import { Button } from '@/components/design/Button';
import { TemplateFrame } from '@/pages/quick-creation-agent/TemplateFrames';

export function HostingLanding() {
  const navigate = useNavigate();
  const others = [
    { title: '第三季度客服复盘', meta: '来自快速创作 · 昨天 18:40 · 访问 46 次', frame: 'whiteboard' as const },
    { title: '新版报销申请指引', meta: '来自 MD 转网页 PPT · 11 月 20 日', frame: 'guide-page' as const },
    { title: '团队年会议程', meta: '手动上传 · 11 月 12 日', frame: 'card-digest' as const },
  ];
  return (
    <div className="mx-auto flex w-full max-w-[1160px] flex-col gap-4 px-4 py-6 md:px-8" data-qc-ready="hosting">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-token-muted">网页托管 · 原型示意（正式页面为 WebPagesPage，按 focusSite 定位）</div>
          <h1 className="m-0 mt-1 text-[20px] font-semibold text-token-primary">我的网页</h1>
        </div>
        <Button variant="secondary" onClick={() => navigate(-1)}>返回快速创作</Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <article className="flex flex-col gap-2.5 rounded-[var(--radius-card)] border border-[color:var(--accent-primary)] bg-[var(--bg-card)] p-2.5 shadow-[0_0_0_4px_rgba(var(--accent-primary-rgb),0.16)]" data-qc="focused-site">
          <div className="overflow-hidden rounded-[var(--radius-control)]"><TemplateFrame frame="visual-note" scene={1} /></div>
          <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-token-primary">需求评审的三个习惯</span><Badge size="sm" variant="success">刚刚发布</Badge></div>
          <div className="text-[11.5px] text-token-muted">来自快速创作 · 视频播放页 · 1:36</div>
          <div className="flex gap-1.5"><Button size="xs"><Copy size={12} />复制链接</Button><Button size="xs"><Share2 size={12} />分享设置</Button></div>
        </article>
        {others.map(o => (
          <article key={o.title} className="flex flex-col gap-2.5 rounded-[var(--radius-card)] border border-token-subtle bg-[var(--bg-card)] p-2.5">
            <div className="overflow-hidden rounded-[var(--radius-control)]"><TemplateFrame frame={o.frame} scene={1} /></div>
            <div className="truncate text-[13.5px] font-medium text-token-primary">{o.title}</div>
            <div className="text-[11.5px] text-token-muted">{o.meta}</div>
          </article>
        ))}
      </div>
      <div role="status" className="flex max-w-[420px] items-start gap-2.5 self-end rounded-[var(--radius-card)] border border-token-subtle bg-[var(--panel-solid)] p-3.5 text-[13px] text-token-primary shadow-lg">
        <Check size={16} className="mt-0.5 text-[color:var(--accent-fg-success)]" aria-hidden />
        <span>已发布，已为你定位到这条记录。<span className="block text-[12px] text-token-muted">默认仅团队成员可看，可在分享设置里修改。</span></span>
      </div>
    </div>
  );
}

export function ToolboxLanding() {
  const navigate = useNavigate();
  const tools = [
    { name: 'MD 转网页 PPT', desc: '粘贴 Markdown 生成网页演示', icon: Globe },
    { name: '快速创作', desc: '一份文档 + 一个模板，得到能播放的视频或能浏览的网页', icon: Clapperboard, on: true },
    { name: '视频创作智能体', desc: '用生成式视频模型做镜头', icon: Film },
    { name: '文学创作智能体', desc: '长文写作与配图', icon: Library },
  ];
  return (
    <div className="mx-auto w-full max-w-[1160px] px-4 py-6 md:px-8" data-qc-ready="toolbox">
      <div className="text-[12px] text-token-muted">AI 百宝箱 · 原型示意（入口来自 navRegistry 的 section: toolbox）</div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tools.map(t => (
          <button key={t.name} type="button" onClick={() => t.on && navigate('/quick-creation-agent')}
            className={`flex gap-3 rounded-[var(--radius-card)] border p-3.5 text-left hover-bg-soft ${t.on ? 'border-[color:var(--accent-primary)] shadow-[inset_0_0_0_1px_var(--accent-primary)]' : 'border-token-subtle'}`}>
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-field)] bg-token-nested text-token-secondary"><t.icon size={18} /></span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-[13.5px] font-semibold text-token-primary">{t.name}{t.on && <Badge size="sm" variant="new">开发中</Badge>}</span>
              <span className="mt-1 block text-[12px] leading-5 text-token-muted">{t.desc}</span>
            </span>
            {t.on && <ExternalLink size={14} className="ml-auto shrink-0 text-token-muted" aria-hidden />}
          </button>
        ))}
      </div>
    </div>
  );
}
