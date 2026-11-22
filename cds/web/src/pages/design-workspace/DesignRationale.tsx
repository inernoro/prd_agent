import { marked, type Tokens } from 'marked';
import { Link } from 'react-router-dom';
import type { DesignEntry, DesignVersion, FrameworkRevision } from '../../../../src/shared/design-workspace';
import { designFrameworkRules } from '../../../../src/shared/design-framework-rules';
import { InlineDesignNotes, ReadableNotes } from './DesignMarkdown';

type RationaleSection = { heading: string; body: string };
const rationaleHeadings = new Map([
  ['目标', 'goal'], ['关键取舍', 'choices'], ['依据的框架规则', 'rules'], ['依据的规则', 'rules'],
  ['待定', 'open'], ['待定问题', 'open'],
]);

function rationaleSections(source: string) {
  const sections: RationaleSection[] = [{ heading: '', body: '' }];
  for (const token of marked.lexer(source)) {
    if (token.type === 'heading' && (token as Tokens.Heading).depth <= 2) {
      sections.push({ heading: (token as Tokens.Heading).text.trim(), body: '' });
    } else {
      sections[sections.length - 1].body += token.raw;
    }
  }
  return sections;
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
  const sections = rationaleSections(authorVersion.rationale);
  const recognized = sections.some(section => rationaleHeadings.has(section.heading));
  if (!recognized) return <div className="dw-surface dw-markdown"><ReadableNotes source={authorVersion.rationale} /></div>;
  const content = (key: string) => sections.filter(section => rationaleHeadings.get(section.heading) === key)
    .map(section => section.body.trim()).filter(Boolean).join('\n\n');
  const frameworkUrl = baseline && version.framework && authorVersion.version === version.version
    ? '/design?' + new URLSearchParams({ project: entry.projectId, framework: version.framework, version: String(baseline.version), tab: 'rules' })
    : undefined;
  const more = sections.filter(section => !rationaleHeadings.has(section.heading) && section.body.trim());
  return <div className="dw-rationale">
    {authorVersion.version !== version.version && <p className="dw-muted">沿用 V{authorVersion.version} 的思路。</p>}
    <section className="dw-rationale-goal"><h2>目标</h2><ReadableNotes source={content('goal')} /></section>
    <section><h2>关键取舍</h2><Tradeoffs source={content('choices')} /></section>
    <div className="dw-rationale-details">
      <section><h2>依据的框架规则</h2><FrameworkReferences source={content('rules')} href={frameworkUrl} baseline={baseline} /></section>
      <section><h2>待定</h2><ReadableNotes source={content('open')} /></section>
    </div>
    {more.map((section, index) => <section key={index}>
      {section.heading && section.heading !== '设计思路' && <h2><InlineDesignNotes source={section.heading} /></h2>}
      <ReadableNotes source={section.body} />
    </section>)}
  </div>;
}
