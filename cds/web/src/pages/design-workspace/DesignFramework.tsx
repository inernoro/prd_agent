import { useState } from 'react';
import { ChevronLeft, Copy, Shapes, Terminal } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { DesignFramework as Framework, DesignMaterial, FrameworkRevision } from '../../../../src/shared/design-workspace';
import { designFrameworkRules } from '../../../../src/shared/design-framework-rules';
import { designDate, materialNames } from './design-ui';

const frameworkTabs = ['tokens','components','skeleton','rules','history'] as const;
export type FrameworkTab = typeof frameworkTabs[number];

function colorsOf(material: DesignMaterial) {
  return Array.isArray(material.tokens?.colors) ? material.tokens.colors.filter((color): color is { name: string; light: string; dark: string; use?: string } =>
    Boolean(color && typeof color.name === 'string' && typeof color.light === 'string' && typeof color.dark === 'string')) : [];
}

function typeOf(material: DesignMaterial) {
  const values = material.tokens?.type ?? material.tokens?.typography;
  return Array.isArray(values) ? values.filter((row): row is { use: string; size: number; weight: number } =>
    Boolean(row && typeof row.use === 'string' && Number.isFinite(row.size) && Number.isFinite(row.weight))) : [];
}

function tokenEntries(value: unknown): Array<[string, string | number]> {
  return Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {}).filter(
    (entry): entry is [string, string | number] => typeof entry[1] === 'string' || (typeof entry[1] === 'number' && Number.isFinite(entry[1])));
}

export function FrameworkOverview({ material, used }: { material: DesignMaterial; used: number }) {
  const colors = colorsOf(material);
  const sizes = typeOf(material);
  const rules = designFrameworkRules(material.rules ?? '').size;
  return <div className="dw-framework-overview">
    {!!colors.length && <div className="dw-framework-swatches" aria-label="框架配色">
      {colors.slice(0, 8).map(color => <span key={color.name} title={color.name} style={{ backgroundColor: color.light }} />)}
    </div>}
    <div className="dw-framework-properties">
      {!!sizes.length && <span><strong>Aa</strong> {sizes.slice(0, 3).map(row => row.size).join(' · ')}</span>}
      {!!rules && <small>{rules} 条规则</small>}
    </div>
    <small>{[material.components && '组件', (material.skeleton || material.tokens?.skeleton) && '页面骨架', `${used} 份稿件使用`].filter(Boolean).join(' · ')}</small>
  </div>;
}

export function DesignMaterialView({ material, tab }: { material: DesignMaterial; tab: Exclude<FrameworkTab, 'history'> }) {
  if (tab === 'tokens') {
    const colors = colorsOf(material);
    const typography = typeOf(material);
    const spacing = material.tokens?.space ?? material.tokens?.spacing;
    const gaps: number[] = Array.isArray(spacing) ? spacing.filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 0) : [];
    const radii = tokenEntries(material.tokens?.radius ?? material.tokens?.radii);
    const fonts = tokenEntries(material.tokens?.font);
    const layout = tokenEntries(material.tokens?.skeleton);
    return material.tokens ? <div className="dw-material">
      {!!colors.length && <section><h3>颜色</h3><div className="dw-token-grid">{colors.map(color =>
        <article className="dw-surface dw-token" key={color.name}><div><i style={{ backgroundColor: color.light }} /><i style={{ backgroundColor: color.dark }} /></div>
          <strong>{color.name}</strong><small>{color.use}</small><code>{color.light} / {color.dark}</code>
        </article>)}</div></section>}
      <div className="dw-token-properties">
        {(!!typography.length || !!fonts.length) && <section><h3>字阶</h3><div className="dw-surface dw-token-list">
          {typography.map(row => <div key={row.use}><small>{row.use}</small><span style={{ fontSize: Math.min(42, Math.max(10, row.size)), fontWeight: row.weight }}>成员与权限</span>
            <code>{row.size} / {row.weight}</code></div>)}
          {fonts.map(([name, value]) => <div key={name}><small>{name === 'sans' ? '正文' : name === 'mono' ? '等宽' : name}</small><code>{value}</code></div>)}
        </div></section>}
        {(!!gaps.length || !!radii.length) && <section><h3>间距与圆角</h3><div className="dw-surface dw-token-list">
          {gaps.map((gap, index) => <div className="dw-token-gap" key={`${gap}-${index}`}><i style={{ width: Math.min(120, gap * 2) }} /><code>{gap}</code></div>)}
          {!!radii.length && <div className="dw-token-radii">{radii.map(([name, value]) => <span key={name}>
            <i style={{ borderRadius: typeof value === 'number' ? Math.max(0, value) : value }} /><small>{({ control: '控件', card: '卡片', gallery: '稿件' } as Record<string, string>)[name] ?? name} {value}</small></span>)}</div>}
        </div></section>}
      </div>
      {!!layout.length && <section><h3>页面骨架</h3><dl className="dw-surface dw-token-list">{layout.map(([name, value]) =>
        <div key={name}><dt>{name === 'pageHeader' ? '页头' : name === 'scrollbarGutter' ? '滚动条留白' : name}</dt><dd>{value}</dd></div>)}</dl></section>}
      {!colors.length && !typography.length && !fonts.length && !gaps.length && !radii.length && !layout.length
        && <pre className="dw-surface">{JSON.stringify(material.tokens, null, 2)}</pre>}
    </div> : <p className="dw-placeholder">没有附加令牌。</p>;
  }
  const detail = material[tab];
  if (tab === 'skeleton' && !detail) {
    const layout = tokenEntries(material.tokens?.skeleton);
    if (layout.length) return <section className="dw-surface dw-markdown"><h3>页面骨架</h3>
      <dl className="dw-token-list">{layout.map(([name, value]) => <div key={name}>
        <dt>{name === 'pageHeader' ? '页头' : name === 'scrollbarGutter' ? '滚动条留白' : name}</dt><dd>{value}</dd>
      </div>)}</dl>
    </section>;
  }
  if (!detail) return <p className="dw-placeholder">没有附加{materialNames[tab]}。</p>;
  if (tab === 'skeleton') return <section className="dw-surface">
    <h3>页面骨架</h3>
    <iframe className="dw-skeleton-preview" sandbox="" referrerPolicy="no-referrer" title="页面骨架"
      srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'">${detail}`} />
    <details><summary>查看源码</summary><pre>{detail}</pre></details>
  </section>;
  return <div className="dw-markdown dw-surface"><ReadableNotes source={detail} /></div>;
}

export function ReadableNotes({ source }: { source: string }) {
  return <>{source.split(/\r?\n\s*\r?\n/).map((block, index) => {
    const trimmed = block.trim();
    if (!trimmed) return null;
    const lines = trimmed.split(/\r?\n/);
    if (lines.length > 2 && lines[0].startsWith('|') && /^\|[ |:\-]+\|$/.test(lines[1]) && lines.slice(2).every(line => /^\|.*\|$/.test(line))) {
      const cells = (line: string) => line.slice(1, -1).split(/(?<!\\)\|/).map(value => value.trim().replace(/\\\|/g, '|'));
      return <div key={index} className="dw-notes-table" role="region" aria-label="规范列表" tabIndex={0}>
        <table><thead><tr>{cells(lines[0]).map((cell, column) => <th scope="col" key={column}>{cell}</th>)}</tr></thead>
          <tbody>{lines.slice(2).map((line, row) => <tr key={row}>{cells(line).map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></table>
      </div>;
    }
    const heading = lines[0].match(/^#{1,5}\s+(.+)$/);
    const body = heading ? lines.slice(1) : lines;
    return <section key={index}>
      {heading && <h3>{heading[1]}</h3>}
      {body.length > 0 && (body.every(line => line.startsWith('- '))
        ? <ul>{body.map((line, i) => <li key={i}>{line.slice(2)}</li>)}</ul> : <p>{body.join('\n')}</p>)}
    </section>;
  })}</>;
}

export function DesignFrameworkView({ framework, revision, tab, onTab, back }: {
  framework: Framework; revision?: FrameworkRevision; tab: FrameworkTab; onTab: (tab: FrameworkTab) => void; back: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const current = revision ?? framework.versions.at(-1)!;
  const cli = `cdscli design scaffold --framework ${framework.id} --dir design/ --title \"新稿件\"`;
  return <>
    <header className="dw-head dw-row">
      <button type="button" className="ep-button ep-icon-button" aria-label="返回设计库" onClick={back}><ChevronLeft /></button>
      <Shapes /><h1>{current.title}</h1><span className="ep-badge">v{current.version}</span>
      <details className="ep-new dw-right">
        <summary className="ep-button"><Terminal />生成脚手架</summary>
        <div className="dw-cli"><code>{cli}</code><button type="button" onClick={async () => {
          await navigator.clipboard.writeText(cli); setCopied(true);
        }}><Copy />{copied ? '已复制' : '复制命令'}</button></div>
      </details>
    </header>
    <nav className="dw-tabrow dw-tablinks" aria-label="框架标签">
      {frameworkTabs.map(value => <button key={value} className="dw-tab" type="button" aria-current={tab === value} onClick={() => onTab(value)}>
        {value === 'history' ? '记录' : materialNames[value]}</button>)}
    </nav>
    {tab === 'history' ? <ol className="dw-surface dw-history">{[...framework.versions].reverse().map(version =>
      <li key={version.version}><strong>v{version.version}</strong><code>{version.sourceCommit.slice(0, 8)}</code>
        <small>{version.sourceVerification === 'git' ? '已核验' : '发布声明'}</small>
        <small>{designDate(version.at)}</small><span>{version.note ?? (version.from ? '从已定稿的稿件提取' : '从 Git 提交导入')}</span>
        {version.from && <Link className="ep-link" to={`/design?project=${encodeURIComponent(framework.projectId)}&design=${encodeURIComponent(version.from.designId)}&version=${version.from.version}`}>
          {version.from.designId} · V{version.from.version}</Link>}
      </li>)}</ol> : <DesignMaterialView material={current.material} tab={tab} />}
  </>;
}
