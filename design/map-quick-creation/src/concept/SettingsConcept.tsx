/* 概念稿（只用于原型，不进源码差异）：快捷版之后开放的「设置」。默认收起，全部可选；口语要求被翻译成选项，并注明来自哪句话。 */
import { useState } from 'react';
import { ChevronDown, Play, SlidersHorizontal } from 'lucide-react';
import { Badge } from '@/components/design/Badge';
import { Button } from '@/components/design/Button';
import { SegmentedTabs } from '@/components/design/SegmentedTabs';
import { Switch } from '@/components/design/Switch';
import { TemplateFrame } from '@/pages/quick-creation-agent/TemplateFrames';

function Field({ label, from, children }: { label: string; from?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)] items-start gap-3 border-b border-token-subtle py-2.5 last:border-b-0">
      <span className="pt-1.5 text-[12.5px] text-token-secondary">{label}</span>
      <div className="min-w-0 space-y-1.5">{children}{from && <div className="text-[11.5px] text-token-muted">来自「{from}」</div>}</div>
    </div>
  );
}

export function SettingsConcept() {
  const [open, setOpen] = useState(true);
  const [speed, setSpeed] = useState<'normal' | 'fast'>('fast');
  const [length, setLength] = useState<'auto' | 'short' | 'long'>('auto');
  const [audience, setAudience] = useState<'new' | 'team' | 'client'>('new');
  const [preview, setPreview] = useState(true);
  return (
    <div className="flex h-full min-h-0 flex-col" data-qc-ready="concept-settings">
      <header className="flex min-h-14 items-center gap-3 border-b border-token-subtle px-5 py-2">
        <div className="min-w-0 flex-1"><div className="text-[11px] text-token-muted">快速创作</div><div className="text-[15px] font-semibold text-token-primary">需求评审的三个习惯</div></div>
        <Badge variant="warning">概念稿 · 开放前不上线</Badge>
      </header>
      <div className="grid min-h-0 flex-1 gap-0 md:grid-cols-[480px_minmax(0,1fr)]">
        <section className="flex min-h-0 flex-col border-r border-token-subtle px-5 py-4">
          <p className="m-0 text-[12.5px] leading-6 text-token-secondary">快捷路径不变：不展开也能生成。展开后，你说的那句话会被翻译成下面的选项，可以核对或改；改过的值不会被再次覆盖。</p>
          <div className="mt-auto space-y-2 rounded-[var(--radius-card)] border border-[var(--border-default)] bg-[var(--panel-solid)] p-3">
            <div className="text-[13.5px] text-token-primary">稍微快一点，先提醒我三个重点，给新同事看</div>
            <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} className="flex w-full items-center gap-2 border-t border-token-subtle pt-2 text-left text-[13px] font-medium text-token-primary">
              <SlidersHorizontal size={15} />设置<Badge size="sm">已识别 3 项</Badge><ChevronDown size={15} className={`ml-auto transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
            {open && (
              <div>
                <Field label="语速" from="稍微快一点">
                  <div className="flex flex-wrap items-center gap-2">
                    <SegmentedTabs ariaLabel="语速" value={speed} onChange={setSpeed} items={[{ key: 'normal', label: '普通' }, { key: 'fast', label: '稍快' }]} />
                    <Button size="sm"><Play size={12} />对比试听</Button>
                  </div>
                </Field>
                <Field label="时长">
                  <SegmentedTabs ariaLabel="时长" value={length} onChange={setLength} items={[{ key: 'auto', label: '按稿件 约 1:30' }, { key: 'short', label: '压到 1 分钟' }, { key: 'long', label: '展开到 2 分钟' }]} />
                </Field>
                <Field label="重点预告" from="先提醒我三个重点">
                  <Switch checked={preview} onCheckedChange={setPreview} label="第一幕前预告 3 个重点" />
                  {preview && ['先读目标', '再画边界', '最后对验收'].map((t, i) => (
                    <div key={t} className="flex h-9 items-center gap-2 rounded-[var(--radius-control)] border border-token-subtle bg-token-nested px-2.5 text-[12.5px] text-token-primary">
                      <span className="text-[color:var(--accent-primary)]">{i + 1}</span>{t}{i === 2 && <span className="ml-auto text-[11px] text-token-muted">2–4 个</span>}
                    </div>
                  ))}
                </Field>
                <Field label="受众" from="给新同事看">
                  <SegmentedTabs ariaLabel="受众" value={audience} onChange={setAudience} items={[{ key: 'new', label: '新同事' }, { key: 'team', label: '团队内' }, { key: 'client', label: '客户' }]} />
                </Field>
              </div>
            )}
            <div className="flex justify-end"><Button variant="primary">快捷生成</Button></div>
          </div>
        </section>
        <section className="space-y-3 overflow-y-auto px-6 py-4">
          <div className="text-[12px] font-medium text-token-secondary">片头预告效果</div>
          <div className="overflow-hidden rounded-[var(--radius-card)] border border-token-subtle"><TemplateFrame frame="visual-note" scene={2} /></div>
          <div className="grid gap-2.5 sm:grid-cols-3 text-[12.5px] leading-6 text-token-secondary">
            <div className="rounded-[var(--radius-field)] border border-token-subtle p-3"><b className="text-token-primary">语速先给两档。</b>数据按连续值存，以后可加档，界面结构不变。</div>
            <div className="rounded-[var(--radius-field)] border border-token-subtle p-3"><b className="text-token-primary">口语优先，表单兜底。</b>每项注明来源，用户改过的值不再被覆盖。</div>
            <div className="rounded-[var(--radius-field)] border border-token-subtle p-3"><b className="text-token-primary">默认收起。</b>展开状态按用户记住。</div>
          </div>
        </section>
      </div>
    </div>
  );
}
