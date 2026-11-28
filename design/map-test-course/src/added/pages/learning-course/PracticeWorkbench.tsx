import { useEffect, useMemo, useRef, useState } from 'react';
import { Columns2, Layers } from 'lucide-react';
import { SEVERITY_REGISTRY } from './registry';
import type { CodeFile, Decision, Finding, Practice } from './types';

type Row = { n: number | null; text: string; diff?: 'add' | 'del'; finding?: Finding };

/* 把被采纳的修复按 diff 行插回源码：'-' 行标删除，'+' 行标新增，其余原样 */
function buildRows(file: CodeFile, findings: Finding[], decisions: Record<string, Decision>, showFixes: boolean): Row[] {
  const byLine = new Map<number, Finding>();
  findings.filter(f => f.location.file === file.path && f.location.line).forEach(f => byLine.set(f.location.line!, f));
  const rows: Row[] = [];
  file.lines.forEach((text, i) => {
    const n = i + 1;
    const f = byLine.get(n);
    if (showFixes && f && decisions[f.id] === 'accept' && f.fix?.length) {
      f.fix.forEach(d => rows.push({ n: d.startsWith('-') ? n : null, text: d.slice(1), diff: d.startsWith('-') ? 'del' : 'add', finding: f }));
    } else rows.push({ n, text, finding: f });
  });
  return rows;
}

function CodeView({ practice, findings, decisions, selected, onSelect, showFixes }: WorkbenchProps & { practice: Practice & { subject: { kind: 'code' } } }) {
  const files = practice.subject.files;
  const [fileIdx, setFileIdx] = useState(0);
  const file = files[Math.min(fileIdx, files.length - 1)];
  const rows = useMemo(() => buildRows(file, findings, decisions, showFixes), [file, findings, decisions, showFixes]);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const f = findings.find(x => x.id === selected);
    if (f?.location.file && f.location.file !== file.path) { const i = files.findIndex(x => x.path === f.location.file); if (i >= 0) setFileIdx(i); }
    const row = box.current?.querySelector<HTMLElement>(`[data-finding-row="${selected}"]`);
    if (row && box.current) box.current.scrollTo({ top: Math.max(0, row.offsetTop - 60), behavior: 'smooth' });
  }, [selected, findings, file.path, files]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="lc-object-head overflow-x-auto shrink-0" style={{ scrollbarWidth: 'none' }}>
        <span className="lc-kicker shrink-0">被检物</span>
        {files.map((f, i) => (
          <button key={f.path} type="button" className="lc-file" aria-current={i === fileIdx} onClick={() => setFileIdx(i)} data-qc-touch-exempt>{f.path}</button>
        ))}
        <span className="flex-1" />
        <span className="text-[11.5px] lc-ink3 shrink-0">{findings.length ? `${findings.length} 处标注` : '等待检查'}</span>
      </div>
      <div ref={box} className="lc-scroll flex-1 lc-code" data-lc="code-view" style={{ overflowX: 'auto' }}>
        {rows.map((r, i) => {
          const sev = r.finding ? SEVERITY_REGISTRY[r.finding.severity] : null;
          const first = r.finding && (i === 0 || rows[i - 1].finding?.id !== r.finding.id);
          return (
            <div key={i} className="lc-code-row" data-flag={!!r.finding} data-selected={!!r.finding && r.finding.id === selected} data-diff={r.diff} data-finding-row={first ? r.finding!.id : undefined}>
              <span>
                {first && sev && (
                  <button type="button" className="lc-flag" style={{ color: sev.color }} onClick={() => onSelect(r.finding!.id)} aria-label={`${sev.label}：${r.finding!.title}`} data-qc-touch-exempt>
                    <span>{findings.indexOf(r.finding!) + 1}</span>
                  </button>
                )}
              </span>
              <span className="lc-ln">{r.n ?? ''}</span>
              <span className="lc-src">{r.diff === 'add' ? '+ ' : r.diff === 'del' ? '- ' : '  '}{r.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function VisualView({ practice, findings, decisions, selected, onSelect, showFixes }: WorkbenchProps & { practice: Practice & { subject: { kind: 'visual' } } }) {
  const s = practice.subject;
  const [mode, setMode] = useState<'side' | 'overlay'>('side');
  const [mix, setMix] = useState(50);
  const regions = (
    findings.filter(f => f.location.region).map((f, i) => {
      const r = f.location.region!;
      const fixed = showFixes && decisions[f.id] === 'accept';
      return (
        <button key={f.id} type="button" className="lc-region" data-severity={f.severity} data-selected={f.id === selected}
          style={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%`, color: SEVERITY_REGISTRY[f.severity].color, opacity: fixed ? 0.3 : 1 }}
          onClick={() => onSelect(f.id)} aria-label={f.title} data-qc-touch-exempt>
          <span className="lc-region-tag"><span>{i + 1}</span></span>
        </button>
      );
    })
  );
  return (
    <div className="flex flex-col h-full min-h-0 p-4 gap-3 lc-grid-bg" data-lc="visual-view">
      <div className="flex items-center gap-2 flex-wrap shrink-0">
        <span className="lc-kicker">被检物</span>
        <div className="flex gap-1" role="group" aria-label="对照方式">
          <button type="button" className="lc-tool" aria-pressed={mode === 'side'} onClick={() => setMode('side')}><Columns2 size={14} />并排</button>
          <button type="button" className="lc-tool" aria-pressed={mode === 'overlay'} onClick={() => setMode('overlay')}><Layers size={14} />叠加</button>
        </div>
        <span className="text-[12px] lc-ink3">{s.viewport} · {s.theme} · 同一份演示数据</span>
      </div>
      {mode === 'side' ? (
        <div className="grid gap-3 flex-1 min-h-0 content-start" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
          <figure className="flex flex-col gap-1.5">
            <figcaption className="lc-kicker">基线（上一版）</figcaption>
            <img src={s.baselineUrl} alt="基线截图" className="w-full rounded-[10px]" style={{ boxShadow: '0 0 0 1px var(--lc-line)' }} />
          </figure>
          <figure className="flex flex-col gap-1.5">
            <figcaption className="lc-kicker">实际（本次改动）</figcaption>
            <div className="relative">
              <img src={s.actualUrl} alt="实际截图" className="w-full rounded-[10px] block" style={{ boxShadow: '0 0 0 1px var(--lc-line)' }} />
              {regions}
            </div>
          </figure>
        </div>
      ) : (
        <div className="flex flex-col gap-2 flex-1 min-h-0">
          <div className="relative max-w-[720px] w-full">
            <img src={s.baselineUrl} alt="基线截图" className="w-full rounded-[10px] block" style={{ boxShadow: '0 0 0 1px var(--lc-line)' }} />
            <img src={s.actualUrl} alt="实际截图" className="w-full rounded-[10px] absolute inset-0" style={{ opacity: mix / 100 }} />
            {regions}
          </div>
          <label className="flex items-center gap-3 text-[12px] lc-ink2 max-w-[720px]">
            基线<input type="range" min={0} max={100} value={mix} onChange={e => setMix(Number(e.target.value))} className="flex-1" style={{ minHeight: 44 }} />实际
          </label>
        </div>
      )}
    </div>
  );
}

export interface WorkbenchProps {
  practice: Practice;
  findings: Finding[];
  decisions: Record<string, Decision>;
  selected?: string;
  onSelect: (id: string) => void;
  /** 复测后展示已应用的修复 */
  showFixes: boolean;
}

export function PracticeWorkbench(props: WorkbenchProps) {
  const { practice } = props;
  return (
    <div className="lc-panel lc-object h-full" data-tour-id="practice-workbench">
      {practice.subject.kind === 'code'
        ? <CodeView {...props} practice={practice as Practice & { subject: { kind: 'code' } }} />
        : <VisualView {...props} practice={practice as Practice & { subject: { kind: 'visual' } }} />}
    </div>
  );
}
