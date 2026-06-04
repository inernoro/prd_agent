import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

/**
 * 周报「关键更新脉络」时间线渲染器。
 *
 * 背景：mermaid 的 `timeline` 图天生横向布局，一周七天 × 每天多事件全挤在一行，
 * 节点越多每个越窄、字越小，加上多 section 配色对比低，用户反馈"看不清"。
 * 本组件把 mermaid timeline 语法解析成结构化数据，改用纵向分组卡片排版：
 * 每个 section（一天）一个区块，区块内是事件卡片（标题 + 说明），事件再多也只往下延伸。
 *
 * 仅接管「内容是 timeline」的 mermaid 块（见 MarkdownViewer 里的分流）；
 * 其它 mermaid 图（flowchart / sequence / gantt 等）仍走 MermaidDiagram，互不影响。
 */

export interface TimelineEvent {
  title: string;
  details: string[];
}

export interface TimelineSection {
  /** section 标签（如 "04-13 周一"）。无 section 的散事件归入 label 为空的隐式分组。 */
  label: string;
  events: TimelineEvent[];
}

export interface ParsedTimeline {
  title: string | null;
  sections: TimelineSection[];
}

/**
 * 解析 mermaid timeline 源码。不是 timeline（首个非空行首词不是 timeline）时返回 null，
 * 让调用方回退到通用 MermaidDiagram 渲染。
 */
export function parseMermaidTimeline(src: string): ParsedTimeline | null {
  const rawLines = (src ?? '').split(/\r?\n/);
  const lines = rawLines.map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('%%'));
  if (lines.length === 0) return null;

  // 首个非空行首词必须是 timeline
  const firstWord = lines[0].split(/\s+/)[0].toLowerCase();
  if (firstWord !== 'timeline') return null;

  let title: string | null = null;
  const sections: TimelineSection[] = [];
  let current: TimelineSection | null = null;

  const ensureSection = (): TimelineSection => {
    if (!current) {
      current = { label: '', events: [] };
      sections.push(current);
    }
    return current;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0) {
      // 形如 "timeline" 或极少数 "timeline title ..."（容错），首行只取指令
      const afterDirective = line.replace(/^timeline\s*/i, '').trim();
      if (!afterDirective) continue;
      // 万一标题写在了同一行
      if (/^title\s+/i.test(afterDirective)) {
        title = afterDirective.replace(/^title\s+/i, '').trim();
      }
      continue;
    }

    if (/^title\s+/i.test(line)) {
      title = line.replace(/^title\s+/i, '').trim();
      continue;
    }

    if (/^section\s+/i.test(line)) {
      current = { label: line.replace(/^section\s+/i, '').trim(), events: [] };
      sections.push(current);
      continue;
    }

    // 事件行：用冒号切分（兼容全角／半角冒号），第一段为标题，其余为说明项
    const parts = line.split(/\s*[:：]\s*/).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) continue;
    const [eventTitle, ...details] = parts;
    ensureSection().events.push({ title: eventTitle, details });
  }

  // 过滤掉完全没有事件的空 section（如只写了 section 头但没内容）
  const cleaned = sections.filter((s) => s.events.length > 0);
  if (cleaned.length === 0) return null;
  return { title, sections: cleaned };
}

const ACCENT = '#a855f7';

function TimelineBody({ data }: { data: ParsedTimeline }) {
  return (
    <div className="px-1 py-1">
      {data.title && (
        <div
          className="text-[15px] font-semibold mb-5 text-center"
          style={{ color: 'var(--text-primary)' }}
        >
          {data.title}
        </div>
      )}

      <div className="flex flex-col gap-5">
        {data.sections.map((section, si) => (
          <div
            key={`${section.label}-${si}`}
            className="flex flex-col sm:flex-row gap-2 sm:gap-4"
          >
            {/* 左侧：日期标签列（窄屏时退化为顶部一行） */}
            {section.label && (
              <div className="shrink-0 sm:w-[92px] pt-0.5">
                <span
                  className="inline-flex items-center text-[12px] font-semibold px-2.5 py-1 rounded-md whitespace-nowrap"
                  style={{
                    background: 'rgba(168,85,247,0.14)',
                    color: '#d8b4fe',
                    border: '1px solid rgba(168,85,247,0.28)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {section.label}
                </span>
              </div>
            )}

            {/* 右侧：事件卡片墙，宽屏自动多列铺满，窄屏单列 */}
            <div
              className="flex-1 grid gap-2.5"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', alignItems: 'start' }}
            >
              {section.events.map((ev, ei) => (
                <div
                  key={`${ev.title}-${ei}`}
                  className="rounded-lg px-3 py-2.5"
                  style={{
                    background: 'rgba(168,85,247,0.05)',
                    border: '1px solid var(--border-faint)',
                    borderLeft: `2px solid ${ACCENT}`,
                  }}
                >
                  <div className="text-[13px] font-semibold leading-snug" style={{ color: 'var(--text-primary)' }}>
                    {ev.title}
                  </div>
                  {ev.details.length > 0 && (
                    <div className="mt-1 flex flex-col gap-0.5">
                      {ev.details.map((d, di) => (
                        <div key={di} className="text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                          {d}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 渲染入口。传入 mermaid timeline 源码：能解析就走纵向时间线；
 * 解析不出（理论上不会，因为调用方已用 parseMermaidTimeline 判过）时降级为源码块。
 */
export function UpdateTimeline({ code }: { code: string }) {
  const [showSource, setShowSource] = useState(false);
  const data = parseMermaidTimeline(code);

  if (!data) {
    return (
      <pre
        className="my-3 text-[12px] overflow-x-auto rounded-lg"
        style={{ padding: '12px 14px', background: 'rgba(0,0,0,0.3)', color: 'var(--text-secondary)' }}
      >
        {code}
      </pre>
    );
  }

  return (
    <div
      className="my-3 rounded-xl overflow-hidden"
      style={{ background: 'var(--bg-input)', border: '1px solid var(--border-faint)' }}
    >
      <div
        className="flex items-center justify-between px-3 py-1.5 text-[10px] tracking-wider"
        style={{
          background: 'rgba(168,85,247,0.08)',
          borderBottom: '1px solid rgba(168,85,247,0.14)',
          color: '#d8b4fe',
        }}
      >
        <span className="font-mono font-semibold">关键更新脉络</span>
        <button
          type="button"
          onClick={() => setShowSource((v) => !v)}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-white/5 transition-colors"
          style={{ color: 'var(--text-muted)' }}
          title={showSource ? '隐藏源码' : '查看源码'}
        >
          {showSource ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          源码
        </button>
      </div>

      <div style={{ padding: '12px 14px' }}>
        <TimelineBody data={data} />
      </div>

      {showSource && (
        <pre
          className="text-[11.5px] overflow-x-auto"
          style={{
            margin: 0,
            padding: '10px 14px',
            background: 'rgba(0,0,0,0.22)',
            color: 'var(--text-secondary)',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            borderTop: '1px solid var(--border-faint)',
            whiteSpace: 'pre',
          }}
        >
          {code}
        </pre>
      )}
    </div>
  );
}
