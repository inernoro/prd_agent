/* 概念稿（只用于原型，不进源码差异）：深入创作 · 逐幕调整。旁白与字幕是同一幕的两部分；改了旁白会提示要更新的字幕与音轨；单幕可回到旧版本。 */
import { useState } from 'react';
import { Pause, RotateCcw, SkipBack, SkipForward } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/design/Badge';
import { Button } from '@/components/design/Button';
import { TemplateFrame } from '@/pages/quick-creation-agent/TemplateFrames';

const scenes = [
  ['片头', 1, 12], ['三个重点', 2, 14], ['先读目标', 3, 14], ['再画边界', 2, 28], ['最后对验收', 3, 18], ['收尾', 1, 10],
] as const;
const steps = ['稿件与重点', '大纲与素材', '逐幕调整', '合成与发布'];

export function StudioConcept() {
  const [active, setActive] = useState(3);
  const [dirty, setDirty] = useState(true);
  return (
    <div className="flex h-full min-h-0 flex-col" data-qc-ready="concept-studio">
      <header className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-1 border-b border-token-subtle px-5 py-2">
        <div className="min-w-0"><div className="text-[11px] text-token-muted">快速创作 · 深入创作</div><div className="text-[15px] font-semibold text-token-primary">需求评审的三个习惯</div></div>
        <ol className="m-0 flex list-none items-center gap-3 p-0 text-[12.5px]">
          {steps.map((s, i) => (
            <li key={s} className={cn('flex items-center gap-1.5', i < 2 ? 'text-token-secondary' : i === 2 ? 'font-medium text-token-primary' : 'text-token-muted')}>
              <span className={cn('inline-flex h-5 w-5 items-center justify-center rounded-full border text-[10.5px]', i === 2 ? 'border-[color:var(--accent-primary)] text-[color:var(--accent-primary)]' : 'border-token-subtle')}>{i + 1}</span>{s}
            </li>
          ))}
        </ol>
        <div className="flex-1" />
        <Badge variant="warning">概念稿 · 开放前不上线</Badge>
        <span className="text-[12px] text-token-muted">最后编辑 今天 15:12</span>
        <Button size="sm" variant="primary">合成成片</Button>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[232px_400px_minmax(0,1fr)]">
        <aside className="space-y-1 overflow-y-auto border-r border-token-subtle p-3" aria-label="幕列表">
          <div className="px-1 pb-1 text-[11.5px] text-token-muted">6 幕 · 1:36 · 拖动可排序</div>
          {scenes.map(([title, frame], i) => (
            <button key={title} type="button" onClick={() => setActive(i)}
              className={cn('grid w-full grid-cols-[20px_60px_minmax(0,1fr)] items-center gap-2 rounded-[var(--radius-field)] border px-2 py-1.5 text-left text-[12.5px]', i === active ? 'border-[color:var(--accent-primary)] bg-[var(--bg-card-hover)]' : 'border-transparent hover-bg-soft')}>
              <span className="text-token-muted">{String(i + 1).padStart(2, '0')}</span>
              <span className="overflow-hidden rounded"><TemplateFrame frame="visual-note" scene={frame} /></span>
              <span className="min-w-0"><span className="block truncate text-token-primary">{title}</span>{i === 3 && dirty && <span className="text-[11px] text-[color:var(--accent-fg-warning)]">字幕与音轨待更新</span>}</span>
            </button>
          ))}
        </aside>
        <section className="space-y-3 overflow-y-auto border-r border-token-subtle px-5 py-4" aria-label="本幕编辑">
          <div className="flex items-center gap-2"><span className="text-[15px] font-semibold text-token-primary">第 {active + 1} 幕 · {scenes[active][0]}</span><Badge size="sm">0:40 – 1:08</Badge></div>
          {dirty && (
            <div className="flex items-center gap-2 rounded-[var(--radius-field)] border border-[color:var(--accent-fg-warning)]/35 bg-[color:var(--accent-fg-warning)]/[0.07] p-2.5 text-[12.5px] text-token-primary">
              <span className="flex-1">你改了旁白，本幕字幕与音轨还是旧的；其他幕不受影响。</span>
              <Button size="xs" onClick={() => setDirty(false)}>更新字幕与音轨</Button>
            </div>
          )}
          <label className="block text-[12.5px] text-token-secondary">旁白<textarea rows={4} defaultValue="第二个习惯，是写清楚这次不做什么。边界没写的需求，评审时最容易越聊越大。把「以后再说」的想法记进待办，而不是塞进本次。" className="mt-1 block w-full resize-none rounded-[var(--radius-field)] border border-token-subtle bg-token-nested p-2.5 text-[13px] leading-6 text-token-primary outline-none" /></label>
          <label className="block text-[12.5px] text-token-secondary">字幕 · 与旁白同一幕{dirty && <Badge size="sm" variant="warning" className="ml-1.5">旧版</Badge>}<textarea rows={2} defaultValue="第二个习惯：写清楚这次不做什么。" className="mt-1 block w-full resize-none rounded-[var(--radius-field)] border border-token-subtle bg-token-nested p-2.5 text-[13px] leading-6 text-token-muted outline-none" /></label>
          <div className="rounded-[var(--radius-card)] border border-token-subtle p-3">
            <div className="mb-1.5 text-[12px] text-token-muted">本幕版本</div>
            <div className="flex items-center gap-2 py-1 text-[12.5px] text-token-primary"><Badge size="sm" variant="success">当前</Badge>v2 · 改了旁白 · 15:12</div>
            <div className="flex items-center gap-2 py-1 text-[12.5px] text-token-secondary"><Badge size="sm">v1</Badge>首次生成 · 14:05<span className="flex-1" /><Button size="xs" variant="ghost">预览</Button><Button size="xs"><RotateCcw size={12} />撤回到此版</Button></div>
          </div>
        </section>
        <section className="space-y-3 overflow-y-auto px-5 py-4" aria-label="本幕试听">
          <div className="text-[12px] font-medium text-token-secondary">本幕试听 · 播放定位到第 {active + 1} 幕</div>
          <div className="overflow-hidden rounded-[var(--radius-card)] border border-token-subtle bg-black">
            <TemplateFrame frame="visual-note" scene={scenes[active][1]} />
            <div className="flex items-center gap-1 bg-[var(--bg-elevated)] px-2 py-1">
              <button type="button" aria-label="上一幕" className="qc-icon-btn" onClick={() => setActive(a => Math.max(0, a - 1))}><SkipBack size={15} /></button>
              <button type="button" aria-label="暂停" className="qc-icon-btn text-token-primary"><Pause size={16} /></button>
              <button type="button" aria-label="下一幕" className="qc-icon-btn" onClick={() => setActive(a => Math.min(5, a + 1))}><SkipForward size={15} /></button>
              <span className="ml-1 text-[12px] text-token-secondary">0:47 / 1:36</span>
            </div>
          </div>
          <div className="flex gap-[3px]">
            {scenes.map(([title, , w], i) => (
              <button key={title} type="button" onClick={() => setActive(i)} style={{ flex: w }}
                className={cn('h-7 truncate rounded border px-1.5 text-left text-[10.5px]', i === active ? 'border-[color:var(--accent-primary)] text-token-primary' : 'border-token-subtle text-token-muted')}>{String(i + 1).padStart(2, '0')} {title}</button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
