import { marked, type Tokens } from 'marked';
import { Link } from 'react-router-dom';
import type { DesignEntry, DesignVersion, FrameworkRevision } from '../../../../src/shared/design-workspace';
import { designFrameworkRules } from '../../../../src/shared/design-framework-rules';
import { InlineDesignNotes, ReadableNotes } from './DesignMarkdown';

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
  let title = '';
  let meta = '';
  let current: Section | undefined;
  for (const token of marked.lexer(source)) {
    if (token.type === 'space' && !current) continue;
    if (token.type === 'heading' && (token as Tokens.Heading).depth === 1 && !title && !current) { title = (token as Tokens.Heading).text.trim(); continue; }
    if (token.type === 'blockquote' && !current) { meta += (token as Tokens.Blockquote).text.trim() + '\n'; continue; }
    if (token.type === 'heading' && (token as Tokens.Heading).depth <= 2) { current = { heading: (token as Tokens.Heading).text.trim(), body: '' }; sections.push(current); continue; }
    if (!current) { current = { heading: '', body: '' }; sections.push(current); }
    current.body += token.raw;
  }
  return { title, meta: meta.trim(), sections: sections.filter(section => section.body.trim() || section.heading) };
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

export function DesignRationale({ entry, version, baseline }: { entry: DesignEntry; version: DesignVersion; baseline?: FrameworkRevision }) {
  const authorVersion = [...entry.versions].reverse().find(row => row.version <= version.version && row.rationale?.trim());
  if (!authorVersion) return <p className="dw-placeholder">这版尚未附设计思路。</p>;
  const { title, meta, sections } = sectionsOf(authorVersion.rationale);
  const frameworkUrl = baseline && version.framework && authorVersion.version === version.version
    ? '/design?' + new URLSearchParams({ project: entry.projectId, framework: version.framework, version: String(baseline.version), tab: 'rules' })
    : undefined;
  /* 每个小节按标题归类；同一类有多节时按出现顺序合在一起；归不了类的放在后面，保持作者的顺序 */
  const slotOf = (section: Section) => folded.test(section.heading) ? undefined : slots.find(([, , , pattern]) => pattern.test(section.heading))?.[0];
  const ordered = [
    ...slots.flatMap(([key, label, purpose]) => {
      const own = sections.filter(section => slotOf(section) === key);
      return own.length ? [{ key, label, purpose, parts: own, fold: false }] : [];
    }),
    ...sections.filter(section => !slotOf(section) && (section.heading || section.body.trim()))
      .map((section, index) => ({ key: `more-${index}`, label: section.heading || '说明', purpose: '', parts: [section], fold: folded.test(section.heading) })),
  ];
  const missing = slots.filter(([key]) => key === 'goal' || key === 'choices').filter(([key]) => !ordered.some(item => item.key === key));
  const anchor = (key: string) => `rationale-${key}`;
  return <div className="dw-rationale dw-rationale--v6">
    <header className="dw-rationale-head">
      {authorVersion.version !== version.version && <p className="dw-muted">沿用 V{authorVersion.version} 的思路。</p>}
      {title && <h2>{title.replace(/^设计思路\s*[·:：]\s*/, '')}</h2>}
      {meta && <p className="dw-dl-factline">{meta.split(/\n+/).map((line, index) => <span key={index}><InlineDesignNotes source={line} /></span>)}</p>}
      <nav className="dw-dl-outline" aria-label="思路目录">{ordered.map((item, index) =>
        <a key={item.key} className="ep-link" href={`#${anchor(item.key)}`} onClick={event => {
          event.preventDefault();
          const target = document.getElementById(anchor(item.key));
          if (target instanceof HTMLDetailsElement) target.open = true;
          target?.scrollIntoView({ block: 'start' });
        }}>{index + 1} {item.label}</a>)}</nav>
    </header>
    {missing.length > 0 && <p className="dw-dl-missing">没写{missing.map(([, label]) => `「${label}」`).join('')}。思路至少要回答这一版解决什么、取舍了什么。</p>}
    <ol className="dw-dl-items dw-surface">
      {ordered.map((item, index) => {
        const body = item.parts.map(part => item.parts.length > 1 && part.heading ? `### ${part.heading}\n\n${part.body}` : part.body).join('\n\n').trim();
        const content = item.key === 'choices' ? <Tradeoffs source={body} />
          : item.key === 'rules' ? <FrameworkReferences source={body} href={frameworkUrl} baseline={baseline} />
          : <ReadableNotes source={body} />;
        const heading = <h4><b>{index + 1}</b><InlineDesignNotes source={item.label} />{item.purpose && <small>{item.purpose}</small>}</h4>;
        return item.fold
          ? <li key={item.key} data-item={item.key}><details id={anchor(item.key)}><summary>{heading}</summary>{content}</details></li>
          : <li key={item.key} id={anchor(item.key)} data-item={item.key}>{heading}{content}</li>;
      })}
    </ol>
  </div>;
}
