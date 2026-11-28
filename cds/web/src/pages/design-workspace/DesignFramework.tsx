import { useState } from 'react';
import { ArrowUpRight, Copy, Layers, Terminal } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { DesignEntry, DesignFramework as Framework, DesignMaterial, DesignMaterialKey, FrameworkRevision } from '../../../../src/shared/design-workspace';
import { adoptedFrameworkVersion } from '../../../../src/shared/design-workspace';
import { designFrameworkRules } from '../../../../src/shared/design-framework-rules';
import { designDate, designStatus, latestDesign, materialNames, statusNames } from './design-ui';
import { describeDesignValue } from './design-structure';
import { ReadableNotes } from './DesignMarkdown';

export const frameworkTabs = ['overview', 'tokens', 'components', 'skeleton', 'rules', 'adoption', 'history'] as const;
export type FrameworkTab = typeof frameworkTabs[number];
const tabNames: Record<FrameworkTab, string> = { overview: '初衷与范围', tokens: '令牌', components: '组件', skeleton: '页面骨架', rules: '规则', adoption: '采用', history: '记录' };
export const charterOf = (revision?: FrameworkRevision) => revision?.charter;
const statusLabel = { adopted: '已采用', draft: '草案', deprecated: '已停用' } as const;
const diffDecision = { framework: '进入公共框架', module: '留在模块规则', pending: '待实现方确认' } as const;

/** 框架标识：在稿件卡片、稿件页头、侧栏和列表里统一写法，一眼区分「这是框架」以及稿件绑定的是哪一版 */
export function FrameworkBadge({ id, version, adopted, compact }: { id: string; version?: number; adopted?: number; compact?: boolean }) {
  const outdated = version !== undefined && adopted !== undefined && version < adopted;
  return <span className="dw-fw-badge" data-outdated={outdated || undefined} title={outdated ? `绑定 v${version}，项目采用 v${adopted}` : undefined}>
    <Layers aria-hidden /><span className="dw-fw-badge-kind">框架</span><code>{id}</code>{version !== undefined && <span>v{version}</span>}
    {outdated && !compact && <em>可升级到 v{adopted}</em>}
  </span>;
}
export function FrameworkStatus({ revision }: { revision?: FrameworkRevision }) {
  const charter = charterOf(revision);
  if (revision?.adoption === null) return <span className="dw-fw-status" data-state="draft">待采用</span>;
  if (revision?.adoption) return <span className="dw-fw-status" data-state="adopted">已采用</span>;
  return <span className="dw-fw-status" data-state={charter?.status ?? 'unknown'}>{charter ? statusLabel[charter.status] : '未写初衷'}</span>;
}

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

/* V25：框架卡片的预览区——配色和字号，和稿件卡片的缩略图占同一个位置 */
export function FrameworkPreview({ material }: { material: DesignMaterial }) {
  const colors = colorsOf(material);
  const sizes = typeOf(material);
  const rules = designFrameworkRules(material.rules ?? '').size;
  return <span className="dw-fwc-sample">
    {colors.length ? <span className="dw-fwc-swatches" aria-label="框架配色">{colors.slice(0, 6).map(color =>
      <i key={color.name} title={color.name} style={{ backgroundColor: color.light }} />)}</span> : <span className="dw-muted">没有配色令牌</span>}
    <span className="dw-fwc-type">{sizes.length ? <><b>Aa</b>{sizes.slice(0, 3).map(row => row.size).join(' · ')}</> : null}{rules ? <small>{rules} 条规则</small> : null}</span>
  </span>;
}

export function FrameworkOverview({ material, used, revision, outdated = 0 }: { material: DesignMaterial; used: number; revision?: FrameworkRevision; outdated?: number }) {
  const charter = charterOf(revision);
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
    {charter ? <p className="dw-fw-intent">{charter.intent}</p> : <p className="dw-fw-intent dw-muted">还没有写设计初衷和要解决的问题</p>}
    {charter && <small className="dw-fw-scope">{[charter.scope.system, charter.scope.modules.join('、')].filter(Boolean).join(' · ')}</small>}
    <small>{[material.components && '组件', (material.skeleton || material.tokens?.skeleton) && '页面骨架', `${used} 份稿件使用`, outdated ? `${outdated} 份可升级` : ''].filter(Boolean).join(' · ')}</small>
  </div>;
}

/** 初衷与范围：框架为什么存在、解决什么、不管什么、管到哪里、规则从哪里来、各模块的差异 */
function FrameworkCharterView({ framework, revision }: { framework: Framework; revision: FrameworkRevision }) {
  const charter = charterOf(revision);
  if (!charter) return <section className="dw-surface dw-fw-empty">
    <h3>这一版还没有写初衷与范围</h3>
    <p>框架会被多份稿件引用。先写清楚它为什么存在、要解决哪些问题、管到哪些模块，评审和实现时才知道什么时候该用、什么时候可以不用。</p>
    <ul><li>从稿件提取时，沿用稿件「思路」里的「这一版解决什么」作为初衷。</li><li>导入时可随规范提供 <code>charter.json</code>，填写初衷、适用范围和维护人。</li></ul>
    <p className="dw-muted">{framework.id} · v{revision.version} · {revision.note ?? '没有发布说明'}</p>
  </section>;
  return <div className="dw-fw-charter">
    <section className="dw-surface dw-fw-intent-card">
      <small>设计初衷</small><p>{charter.intent}</p>
      <div className="dw-fw-meta"><span>维护人 {charter.owner}</span><span>适用范围 {[charter.scope.system, charter.scope.modules.join('、')].filter(Boolean).join(' · ')}</span>
        {charter.example && <Link className="ep-link" to={`/design?project=${encodeURIComponent(framework.projectId)}&design=${encodeURIComponent(charter.example.designId)}&version=${charter.example.version}`}>示意稿 {charter.example.designId} · V{charter.example.version}<ArrowUpRight size={14} /></Link>}</div>
    </section>
    <div className="dw-fw-columns">
      <section className="dw-surface dw-markdown"><h3>要解决的问题</h3><ol>{charter.problems.map(item => <li key={item}>{item}</li>)}</ol></section>
      <section className="dw-surface dw-markdown"><h3>不解决什么</h3><ul>{charter.nonGoals.map(item => <li key={item}>{item}</li>)}</ul></section>
    </div>
    {!!charter.ruleSources?.length && <section className="dw-surface dw-markdown"><h3>规则从哪里来</h3>
      <div className="dw-notes-table" role="region" aria-label="规则来源" tabIndex={0}><table><thead><tr><th scope="col">规则</th><th scope="col">来源</th><th scope="col">依据</th></tr></thead>
        <tbody>{charter.ruleSources.map(row => <tr key={row.rule}><td>{row.rule}</td><td><code>{row.from}</code></td><td>{row.evidence}</td></tr>)}</tbody></table></div></section>}
    {!!charter.moduleDiffs?.length && <section className="dw-surface dw-markdown"><h3>模块差异</h3>
      <p className="dw-muted">各模块和公共框架不一样的地方。由实现方确认进入公共框架还是留在模块规则。</p>
      <div className="dw-notes-table" role="region" aria-label="模块差异" tabIndex={0}><table><thead><tr><th scope="col">模块</th><th scope="col">差异</th><th scope="col">原因</th><th scope="col">处理</th></tr></thead>
        <tbody>{charter.moduleDiffs.map(row => <tr key={row.module + row.diff}><td>{row.module}</td><td>{row.diff}</td><td>{row.reason}</td><td><span className="dw-fw-status" data-state={row.decision === 'pending' ? 'draft' : 'adopted'}>{diffDecision[row.decision]}</span></td></tr>)}</tbody></table></div></section>}
  </div>;
}

/** 采用：哪些稿件绑定了这套框架、各自用哪一版、能不能升级；同项目里还没绑定框架的稿件 */
function FrameworkAdoption({ framework, designs }: { framework: Framework; designs: DesignEntry[] }) {
  const adopted = adoptedFrameworkVersion(framework);
  const bound = frameworkUses(framework.id, designs);
  const unbound = designs.filter(entry => !latestDesign(entry).framework && !entry.versions.find(row => row.version === entry.frozen)?.framework);
  const link = (entry: DesignEntry) => `/design?project=${encodeURIComponent(entry.projectId)}&design=${encodeURIComponent(entry.id)}`;
  return <div className="dw-fw-charter">
    <section className="dw-surface dw-markdown"><h3>采用情况 <small>{bound.length}</small></h3>
      {bound.length ? <div className="dw-notes-table" role="region" aria-label="采用情况" tabIndex={0}><table><thead><tr><th scope="col">稿件</th><th scope="col">阶段</th><th scope="col">绑定版本</th><th scope="col">实施基线</th></tr></thead>
        <tbody>{bound.map(({ entry, binding }) => { const v = binding.frameworkVersion; return <tr key={entry.id}>
          <td><Link className="ep-link" to={link(entry) + '&version=' + binding.version}>{binding.title}</Link> <code>{entry.id}</code></td><td>{statusNames[designStatus(entry)]}</td>
          <td>{v === undefined ? '版本未登记' : adopted !== undefined && v < adopted
            ? <span className="dw-fw-status" data-state="draft">v{v} · 可升级到 v{adopted}</span>
            : <span className="dw-fw-status" data-state={v === adopted ? 'adopted' : 'unknown'}>v{v}{v === adopted ? ' · 项目采用' : ''}</span>}</td>
          <td>{entry.frozen ? `V${entry.frozen}` : '未定稿'}</td></tr>; })}</tbody></table></div> : <p>还没有稿件绑定这套框架。发布稿件时在清单里写 <code>framework</code> 和 <code>frameworkVersion</code>。</p>}
    </section>
    {!!unbound.length && <section className="dw-surface dw-markdown"><h3>同项目里未绑定框架的稿件 <small>{unbound.length}</small></h3>
      <ul>{unbound.map(entry => <li key={entry.id}><Link className="ep-link" to={link(entry)}>{latestDesign(entry).title}</Link> <code>{entry.id}</code> · 下一版发布时可以绑定</li>)}</ul></section>}
  </div>;
}

export function frameworkUses(id: string, designs: DesignEntry[]) {
  return designs.flatMap(entry => {
    const current = latestDesign(entry);
    const baseline = entry.versions.find(row => row.version === entry.frozen)
      ?? (entry.frozen && entry.librarySummary?.baselineFramework
        ? { ...current, ...entry.librarySummary.baselineFramework, version: entry.frozen } : undefined);
    const binding = current.framework === id ? current : baseline?.framework === id ? baseline : undefined;
    return binding ? [{ entry, binding }] : [];
  });
}

export function DesignMaterialView({ material, tab }: { material: DesignMaterial; tab: DesignMaterialKey }) {
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
        && <dl className="dw-surface dw-token-list">{Object.entries(material.tokens).map(([name, value]) => <div key={name}>
          <dt>{name}</dt><dd>{describeDesignValue(value)}</dd>
        </div>)}</dl>}
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

export function DesignFrameworkView({ framework, revision, tab, onTab, designs = [], busy, onAdopt }: {
  framework: Framework; revision?: FrameworkRevision; tab: FrameworkTab; onTab: (tab: FrameworkTab) => void; designs?: DesignEntry[];
  busy?: boolean; onAdopt?: (version: number) => Promise<boolean>;
}) {
  const [copied, setCopied] = useState(false);
  const latest = framework.versions.at(-1)!;
  const current = revision ?? latest;
  const charter = charterOf(current);
  const used = frameworkUses(framework.id, designs);
  const adopted = adoptedFrameworkVersion(framework);
  const outdated = adopted === undefined ? 0 : used.filter(({ binding }) => binding.frameworkVersion !== undefined && binding.frameworkVersion < adopted).length;
  const cli = `cdscli design scaffold --framework ${framework.id} --framework-version ${current.version} --dir design/new-draft --title "新稿件"`;
  return <>
    <header className="dw-head dw-row">
      <div className="dw-fw-head">
        <div className="dw-row"><FrameworkBadge id={framework.id} version={current.version} compact /><h1>{current.title}</h1><FrameworkStatus revision={current} /></div>
        <small>{charter ? `${charter.scope.system} · ${charter.scope.modules.join('、')} · ` : ''}{used.length} 份稿件在用{outdated ? `，${outdated} 份可升级` : ''} · {designDate(current.at)} 更新</small>
      </div>
      <details className="ep-new dw-right">
        <summary className="ep-button"><Terminal />生成脚手架</summary>
        <div className="dw-cli"><code>{cli}</code><button type="button" onClick={async () => {
          await navigator.clipboard.writeText(cli); setCopied(true);
        }}><Copy />{copied ? '已复制' : '复制命令'}</button></div>
      </details>
    </header>
    <nav className="dw-tabrow dw-tablinks" aria-label="框架标签">
      {frameworkTabs.map(value => <button key={value} className="dw-tab" type="button" aria-current={tab === value} onClick={() => onTab(value)}>
        {tabNames[value]}{value === 'adoption' && used.length ? <small>{used.length}</small> : null}</button>)}
    </nav>
    {tab === 'adoption' && current.adoption === null && <section className="dw-surface dw-markdown">
      <h3>采用框架 v{current.version}</h3>
      <p>{adopted === undefined ? '项目还未采用这套框架。' : `项目正在采用 v${adopted}。`}
        采用后，默认使用这套框架的模块会为新稿选用 v{current.version}，已有稿件继续使用各自绑定的版本。</p>
      {current === latest && onAdopt && <div className="dw-row">
        <button type="button" className="ep-button" disabled={busy}
          onClick={() => void onAdopt(current.version)}>确认采用 v{current.version}</button>
      </div>}
    </section>}
    {tab === 'history' ? <ol className="dw-surface dw-history">{[...framework.versions].reverse().map(version =>
      <li key={version.version}><strong>v{version.version}</strong><code>{version.sourceCommit.slice(0, 8)}</code>
        <small>{version.sourceVerification === 'git' ? '已核验' : '发布声明'}</small>
        <small>{designDate(version.at)}</small><span>{version.note ?? (version.from ? '从已定稿的稿件提取' : '从 Git 提交发布')}</span>
        {version.adoption !== undefined && <FrameworkStatus revision={version} />}
        {version.from && <Link className="ep-link" to={`/design?project=${encodeURIComponent(framework.projectId)}&design=${encodeURIComponent(version.from.designId)}&version=${version.from.version}`}>
          {version.from.designId} · V{version.from.version}</Link>}
      </li>)}</ol> : tab === 'overview' ? <FrameworkCharterView framework={framework} revision={current} />
      : tab === 'adoption' ? <FrameworkAdoption framework={framework} designs={designs} />
      : <DesignMaterialView material={current.material} tab={tab} />}
  </>;
}
