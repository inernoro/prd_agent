import { marked, type Tokens } from 'marked';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { DesignEntry, DesignVersion, FrameworkRevision } from '../../../../src/shared/design-workspace';
import { designFrameworkRules } from '../../../../src/shared/design-framework-rules';
import { DesignMaterialView } from './DesignFramework';
import { InlineDesignNotes, ReadableNotes } from './DesignMarkdown';
import { compareDesignMaterial, describeMaterialChange } from './design-structure';
import { cellNames, designDate, materialNames } from './design-ui';

type Section = { heading: string; body: string };
type Slot = 'goal' | 'choices' | 'changes' | 'rules' | 'open';
const slots: [Slot, string, string, RegExp][] = [
  ['goal', '目标', '这一版要解决什么', /^(目标|这一版解决什么|解决什么|为什么|背景与目标)/],
  ['choices', '关键取舍', '选了什么、没选什么、为什么', /取舍|选择与理由/],
  ['changes', '本版改动', '和上一版相比改了哪里', /^(本版改动|改动|修改|改了什么|改动的源码|变化)/],
  ['rules', '依据的规则', '引用的框架规则和原则', /^(依据|依据的框架规则|依据的规则|规则)/],
  ['open', '待定', '还没确定、需要谁决定', /^(待定|待定问题|还没确定|待确认|未确定|还没核实)/],
];
const folded = /回顾|历史|以前|旧版/;

function sectionsOf(source: string) {
  const sections: Section[] = [];
  let current: Section | undefined;
  for (const token of marked.lexer(source)) {
    if (token.type === 'space' && !current || token.type === 'heading' && (token as Tokens.Heading).depth === 1 && !current
      || token.type === 'blockquote' && !current) continue;
    if (token.type === 'heading' && (token as Tokens.Heading).depth <= 2) { current = { heading: (token as Tokens.Heading).text.trim(), body: '' }; sections.push(current); continue; }
    if (!current) { current = { heading: '', body: '' }; sections.push(current); }
    current.body += token.raw;
  }
  return sections.filter(section => section.body.trim() || section.heading);
}

function Tradeoffs({ source }: { source: string }) {
  const blocks = marked.lexer(source).filter(token => token.type !== 'space');
  if (!blocks.length || blocks.some(token => token.type !== 'list')) return <ReadableNotes source={source} />;
  const items = blocks.flatMap(token => (token as Tokens.List).items);
  return <div className="dw-rationale-choices">
    {items.map((item, index) => {
      const [title, ...details] = item.text.trim().split(/\r?\n/);
      return <article className="dw-surface dw-rationale-choice" key={index}>
        <strong><InlineDesignNotes source={title} /></strong>
        {details.map((line, detailIndex) => {
          const text = line.replace(/^\s*[-*+]\s+/, '').trim();
          if (!text) return null;
          const dropped = text.match(/^放弃[：:\s]+(.+)$/);
          return dropped ? <small key={detailIndex}>放弃 <s><InlineDesignNotes source={dropped[1]} /></s></small>
            : <p key={detailIndex}><InlineDesignNotes source={text.replace(/^(?:原因|理由)[：:\s]+/, '')} /></p>;
        })}
      </article>;
    })}
  </div>;
}

function FrameworkReferences({ source, href, baseline }: { source: string; href?: string; baseline?: FrameworkRevision }) {
  const lines = source.trim().split(/\r?\n/).filter(Boolean);
  const notes = lines.map(line => line.match(/^\s*[-*+]\s+(R[-_]\d+)(?:\s*[：:·-]\s*|\s+)?(.*)$/));
  if (!href || !notes.length || notes.some(note => !note)) return <ReadableNotes source={source} />;
  const catalog = designFrameworkRules(baseline?.material.rules ?? '');
  return <ul className="dw-rationale-rules">{notes.map((note, index) => {
    const [, id, title] = note!;
    const name = title.trim() || catalog.get(id)?.name;
    return <li key={index}>{catalog.has(id) ? <Link className="ep-badge" to={href}>
      <code>{id}</code> {name && <InlineDesignNotes source={name} />}</Link> : <>{id} {name && <InlineDesignNotes source={name} />}</>}</li>;
  })}</ul>;
}

function rationaleOrder(entry: DesignEntry, version: DesignVersion) {
  const authorVersion = [...entry.versions].reverse().find(row => row.version <= version.version && row.rationale?.trim());
  const sections = authorVersion ? sectionsOf(authorVersion.rationale) : [];
  const slotOf = (section: Section) => folded.test(section.heading) ? undefined : slots.find(([, , , pattern]) => pattern.test(section.heading))?.[0];
  const ordered = [
    ...slots.flatMap(([key, label, purpose]) => {
      const own = sections.filter(section => slotOf(section) === key);
      return own.length ? [{ key, label, purpose, parts: own, fold: false }] : [];
    }),
    ...sections.filter(section => !slotOf(section) && (section.heading || section.body.trim()))
      .map((section, index) => ({ key: `more-${index}`, label: section.heading || '说明', purpose: '', parts: [section], fold: folded.test(section.heading) })),
  ];
  return { authorVersion, ordered };
}

export function rationaleGoal(entry: DesignEntry, version: DesignVersion) {
  const goal = rationaleOrder(entry, version).ordered.find(item => item.key === 'goal');
  if (!goal) return '';
  const line = goal.parts.flatMap(part => part.body.split(/\r?\n/)).map(text => text.trim()).find(text => text && !text.startsWith('#'));
  return line?.replace(/^[-*>]\s+/, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').split(/(?<=[。！？])/, 1)[0] ?? '';
}

type Note = { key: string; label: string; content: ReactNode; purpose?: string; fold?: boolean };
const noteAnchor = (key: string) => key.startsWith('spec-') ? key : `rationale-${key}`;

function specNotes(version: DesignVersion, baseline?: FrameworkRevision): Note[] {
  const changes = compareDesignMaterial(baseline?.material ?? {}, version.spec).flatMap(change => {
    const details = describeMaterialChange(change);
    return details ? [{ id: change.id, kind: change.kind, ...details }] : [];
  });
  const check = version.frameworkCheck;
  const pending = check?.items.filter(item => item.status !== 'passed') ?? [];
  const material = { ...baseline?.material, ...version.spec };
  return [
    { key: 'spec-diff', label: '和框架的差异', content: <>
      <small>{baseline ? `${version.framework} · V${baseline.version}` : '显示稿件单独声明的规范'}</small>
      {changes.length ? <ul className="dw-dl-plain">{changes.map(row => <li key={row.id}>
        <strong>{row.kind} · {row.label}</strong><p>{row.detail}</p>
      </li>)}</ul> : <p>本版没有单独附加或修改的规范。</p>}
    </> },
    { key: 'spec-tokens', label: '令牌', content: <DesignMaterialView material={material} tab="tokens" /> },
    { key: 'spec-rules', label: '规则、组件和页面骨架', content: <>
      {(['rules', 'components', 'skeleton'] as const).map(key => <details key={key} className="dw-dl-rulegroup" open={key === 'rules' || undefined}>
        <summary>{materialNames[key]}</summary><DesignMaterialView material={material} tab={key} />
      </details>)}
    </> },
    ...(check?.items.length ? [{ key: 'spec-check', label: '发布规则检查', purpose: pending.length ? `${pending.length} 条待核对` : '已核对',
      content: <><small>{check.framework} · V{check.frameworkVersion}</small>
        <ul className="dw-dl-plain dw-notes-checks">{[...pending, ...check.items.filter(row => row.status === 'passed')].map(row => <li key={row.ruleId}>
          <strong>{cellNames[row.status]} · {row.ruleId} {row.name}</strong><p>{row.actual}</p>
        </li>)}</ul></> }] : []),
  ];
}

export function DesignRationale({ entry, version, baseline, focusSpec = false }: {
  entry: DesignEntry; version: DesignVersion; baseline?: FrameworkRevision; focusSpec?: boolean;
}) {
  const { authorVersion, ordered } = rationaleOrder(entry, version);
  const frameworkUrl = baseline && version.framework && authorVersion?.version === version.version
    ? '/design?' + new URLSearchParams({ project: entry.projectId, framework: version.framework, version: String(baseline.version), tab: 'rules' })
    : undefined;
  const why: Note[] = ordered.map(item => {
    const body = item.parts.map(part => item.parts.length > 1 && part.heading ? `### ${part.heading}\n\n${part.body}` : part.body).join('\n\n').trim();
    const content = item.key === 'choices' ? <Tradeoffs source={body} />
      : item.key === 'rules' ? <FrameworkReferences source={body} href={frameworkUrl} baseline={baseline} />
      : <ReadableNotes source={body} />;
    return { key: item.key, label: item.label, content, purpose: item.purpose, fold: item.fold };
  });
  const rules = specNotes(version, baseline);
  const article = useRef<HTMLDivElement>(null);
  const [item, highlight] = useState<string | undefined>(focusSpec ? 'spec-diff' : why[0]?.key);
  const jump = (key: string) => {
    const node = article.current?.querySelector<HTMLElement>(`#${noteAnchor(key)}`);
    const scroll = article.current?.closest('.dw-overlay-body');
    if (!node || !scroll) return;
    const details = node.querySelector('details');
    if (details && node.dataset.fold) details.open = true;
    highlight(key);
    scroll.scrollTo({ top: scroll.scrollTop + node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12 });
  };
  useEffect(() => {
    if (focusSpec) jump('spec-diff');
    const scroll = article.current?.closest('.dw-overlay-body');
    if (!scroll) return;
    const update = () => {
      const nodes = [...(article.current?.querySelectorAll<HTMLElement>('[data-note]') ?? [])];
      const boundary = scroll.getBoundingClientRect();
      const atEnd = scroll.scrollHeight - scroll.clientHeight <= scroll.scrollTop + 1;
      const position = atEnd ? boundary.bottom : boundary.top + 16;
      const visible = nodes.filter(node => node.getBoundingClientRect().top < position).at(-1) ?? nodes[0];
      if (visible) highlight(visible.dataset.note);
    };
    scroll.addEventListener('scroll', update, { passive: true });
    return () => scroll.removeEventListener('scroll', update);
  }, [focusSpec, version.version]);
  const topic = (notes: Note[], start: number) => <ol className="dw-dl-items dw-surface" start={start}>
    {notes.map((note, index) => {
      const heading = <h4><b>{start + index}</b><InlineDesignNotes source={note.label} />{note.purpose && <small>{note.purpose}</small>}</h4>;
      return <li key={note.key} id={noteAnchor(note.key)} data-note={note.key} data-item={note.key} data-fold={note.fold || undefined}>
        {note.fold ? <details><summary>{heading}</summary>{note.content}</details> : <>{heading}{note.content}</>}
      </li>;
    })}
  </ol>;
  return <div className="dw-notes-page dw-notes-page--v17">
    <nav className="dw-notes-toc" aria-label="说明目录">
      {([{ label: '为什么这样设计', notes: why, start: 1 }, { label: '实现时遵守什么', notes: rules, start: why.length + 1 }]).map(group =>
        <div key={group.label}><strong>{group.label}</strong><ol>{group.notes.map((note, index) =>
          <li key={note.key}><a href={`#${noteAnchor(note.key)}`} aria-current={item === note.key ? 'location' : undefined} onClick={event => {
            event.preventDefault(); jump(note.key);
          }}><b>{group.start + index}</b><InlineDesignNotes source={note.label} /></a></li>
        )}</ol></div>)}
    </nav>
    <div className="dw-notes-body dw-rationale dw-rationale--v6" ref={article}>
      <p className="dw-dl-factline">
        <span>{designDate(version.createdAt)}</span>{entry.frozen !== undefined && <span>基线 V{entry.frozen}</span>}
        {version.framework && <span>{version.framework}{version.frameworkVersion && ` · V${version.frameworkVersion}`}</span>}
        {authorVersion && authorVersion.version !== version.version && <span>思路沿用 V{authorVersion.version}</span>}
      </p>
      <section id="notes-why"><h3>为什么这样设计</h3>{why.length ? topic(why, 1) : <p className="dw-muted">这版尚未附设计思路。</p>}</section>
      <section id="notes-spec"><h3>实现时遵守什么</h3>{topic(rules, why.length + 1)}</section>
    </div>
  </div>;
}
