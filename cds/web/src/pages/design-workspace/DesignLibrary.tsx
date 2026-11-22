import { Folder, Grid2X2, Layers, List, Maximize, MessageSquare, Search, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { DesignComment, DesignEntry, DesignModuleRef, DesignTheme, DesignVersion, DesignWorkspace } from '../../../../src/shared/design-workspace';
import { DesignFrame } from './DesignCanvas';
import { charterOf, FrameworkBadge, FrameworkOverview, FrameworkStatus, frameworkUses } from './DesignFramework';
import { DesignRequirementList } from './DesignRequirements';
import { currentDesignRun } from '../../../../src/shared/design-workspace';
import { designArtifact, designDate, designFailureGroups, designStatus, latestDesign, openReviews, scopeKey, statusNames } from './design-ui';

export const libraryStatuses = [
  ['all', '全部状态'], ['attention', '等我处理'], ['review', '待评审'], ['active', '实现中'], ['signed', '已验收'], ['draft', '设计中'], ['frozen', '已定稿'],
] as const;

type LibraryQuery = {
  search: string; group: string; status: string; tag: string; framework: string; system: string; module: string;
};
type ReadChanges = { version?: number; feedbackAt?: string };
export type DesignReadChanges = Record<string, ReadChanges>;
const normalize = (value: string) => value.normalize('NFKC').toLowerCase();

export function designFeedbackAt(entry: DesignEntry) {
  return (entry.feedback ?? []).reduce((latest, thread) => {
    for (const at of [thread.createdAt, thread.replies.at(-1)?.at, thread.decisions.at(-1)?.at, thread.attachments?.at(-1)?.at]) {
      if (at && at > latest) latest = at;
    }
    return latest;
  }, '');
}

function DesignCover({ projectId, version, theme, thumbnail }: {
  projectId: string; version: DesignVersion; theme: DesignTheme; thumbnail?: boolean;
}) {
  const screen = version.screens[0];
  const selectedTheme = screen?.themes.includes(theme) ? theme : screen?.themes[0] ?? theme;
  const render = screen && version.renders?.[screen.id]?.[selectedTheme];
  if (render) return <img src={designArtifact(projectId, render.id)} alt="" loading="lazy" />;
  if (thumbnail) return <span className="dw-mini-empty" aria-hidden><Layers size={16} /></span>;
  return <DesignFrame projectId={projectId} version={version} screen={screen} theme={selectedTheme} zoom={null} decorative />;
}

type CardProps = {
  entry: DesignEntry; workspace: DesignWorkspace; read?: ReadChanges; theme: DesignTheme; href: string;
  onLarge: (entry: DesignEntry, version: DesignVersion) => void;
};
function DesignCard({ entry, workspace, read, theme, href, onLarge }: CardProps) {
  const version = latestDesign(entry);
  const status = designStatus(entry);
  const failures = currentDesignRun(entry)?.cells.filter(cell => cell.status === 'failed').length ?? 0;
  const failedRules = designFailureGroups(version);
  const unread = version.version > (read?.version ?? 0);
  const unreadFeedback = designFeedbackAt(entry) > (read?.feedbackAt ?? '');
  const framework = workspace.frameworks.find(row => row.id === version.framework);
  return <article className="dw-design-card" data-state={status}>
    <div className="dw-thumb">
      <DesignCover projectId={workspace.projectId} version={version} theme={theme} />
      <Link className="dw-card-cover" to={href} aria-label={'打开稿件 ' + version.title} />
      {unread && <span className="dw-card-new" aria-label="有新版本">新</span>}
      <button className="ep-button dw-card-screen" type="button" aria-label={'大屏查看 ' + version.title}
        onClick={() => onLarge(entry, version)}><Maximize />大屏</button>
    </div>
    <footer data-rule-findings={failedRules.length ? true : undefined}>
      <div className="dw-card-heading">
        <Link className="dw-card-title" to={href} title={version.title}>{version.title}</Link>
        <span className="dw-status" data-state={status}>{statusNames[status]}</span>
      </div>
      <div className="dw-card-meta">
        <span className="dw-card-person" title={version.publisher.label}>{version.publisher.label.slice(0, 1)}</span>
        <code>V{version.version}</code><small>{designDate(version.createdAt)}</small>
        {entry.comments.length > 0 && <small className="dw-card-comments"><MessageSquare />{entry.comments.length}</small>}
        {failures > 0 && <Link className="ep-text-button dw-card-failed" to={href + '&tab=accept'}>{failures} 不通过</Link>}
        {unreadFeedback && <Link className="ep-text-button" to={href + '&tab=delivery'}>新反馈</Link>}
        <span className="dw-card-framework">{framework
          ? <FrameworkBadge id={framework.id} version={version.frameworkVersion} latest={framework.versions.at(-1)?.version} />
          : <span className="dw-fw-badge" data-missing>未绑定框架</span>}</span>
      </div>
      {!!failedRules.length && <Link className="ep-text-button dw-card-rule-findings" to={href + '&tab=spec'}>
        {failedRules.map(group => <div key={group.label}>
          <strong>{group.label}</strong>
          <ul>{group.rules.map((row, index) => <li key={row.id + '-' + index}><code>{row.id}</code> {row.name}</li>)}</ul>
        </div>)}
      </Link>}
    </footer>
  </article>;
}

export function DesignLibrary({ workspace, query, onChange, mode, theme, read, frameworkList, onFramework, onReview, onLarge }: {
  workspace: DesignWorkspace; query: LibraryQuery; onChange: (fields: Record<string, string>) => void;
  mode: 'cards' | 'list'; theme: DesignTheme; read: DesignReadChanges; frameworkList: boolean;
  onFramework: (id: string) => void;
  onReview: (entry: DesignEntry, comment: DesignComment, version: DesignVersion) => void; onLarge: CardProps['onLarge'];
}) {
  const { frameworks, permissions, projectId } = workspace;
  const systems = workspace.systems ?? [];
  const requirements = workspace.requirements ?? [];
  const examples = new Set(frameworks.flatMap(row => row.versions.flatMap(revision => {
    const example = charterOf(revision)?.example;
    return example ? [example.designId] : [];
  })));
  const drafts = workspace.designs.filter(row => !examples.has(row.id)).sort((a, b) =>
    latestDesign(b).createdAt.localeCompare(latestDesign(a).createdAt) || a.id.localeCompare(b.id));
  const system = systems.find(row => row.id === query.system);
  const module = system?.modules.find(row => row.id === query.module);
  const systemModules = systems.flatMap(owner => owner.modules.map(row => ({ owner, module: row })));
  const tags = [...new Set(drafts.flatMap(row => latestDesign(row).tags))].sort();
  const scopeMatches = (ref?: DesignModuleRef) => (!query.system || ref?.systemId === query.system)
    && (!query.module || ref?.moduleId === query.module);
  const inScope = (entry: DesignEntry) => scopeMatches(entry.scope) || entry.scope?.related?.some(scopeMatches);
  const attention = (entry: DesignEntry) => {
    const viewer = permissions.steward || latestDesign(entry).publisher.id === permissions.actorId;
    const review = entry.reviewRequested && permissions.review
      && (!entry.reviewers?.length || entry.reviewers.some(row => row.id === permissions.actorId));
    const canCheck = permissions.review && openReviews(entry).some(row => permissions.steward || row.comment.author.id === permissions.actorId);
    const delivery = viewer && entry.feedback?.some(row => row.status === 'open' && row.author.id !== permissions.actorId);
    const acceptance = viewer && currentDesignRun(entry)?.verdict === 'failed';
    return review || canCheck || delivery || acceptance;
  };
  const groupOf = (entry: DesignEntry) => latestDesign(entry).group ?? '未分组';
  const folderOf = (entry: DesignEntry) => entry.scope ? scopeKey(entry.scope) : groupOf(entry);
  const folders = new Map<string, { name: string; entries: DesignEntry[]; scope?: DesignModuleRef }>();
  for (const { owner, module: child } of systemModules) {
    const ref = { systemId: owner.id, moduleId: child.id };
    if (scopeMatches(ref)) folders.set(scopeKey(ref), { name: child.name, entries: [], scope: ref });
  }
  for (const row of drafts.filter(inScope)) {
    const key = folderOf(row);
    const folder = folders.get(key);
    if (folder) folder.entries.push(row);
    else if (!row.scope) folders.set(key, { name: key, entries: [row] });
  }
  const legacyBriefFolder = (designKey: string) => {
    const draft = drafts.find(row => row.designKey === designKey);
    return draft ? groupOf(draft) : '未分组';
  };
  for (const brief of requirements) {
    if (brief.scope || !scopeMatches(brief.scope)) continue;
    const key = legacyBriefFolder(brief.designKey);
    if (!folders.has(key)) folders.set(key, { name: key, entries: [] });
  }
  const scoped = drafts.filter(inScope);
  const selected = scoped.filter(row => {
    const head = latestDesign(row);
    const matchesStatus = query.status === 'attention' ? attention(row) : !query.status || query.status === 'all' || designStatus(row) === query.status;
    return matchesStatus && (!query.group || groupOf(row) === query.group || folderOf(row) === query.group)
      && (!query.tag || head.tags.includes(query.tag)) && (!query.framework || head.framework === query.framework)
      && normalize([head.title, row.id, groupOf(row), folders.get(folderOf(row))?.name, ...head.tags,
        row.pullRequest ? 'PR #' + row.pullRequest : ''].join(' ')).includes(normalize(query.search.trim()));
  });
  const pending = selected.filter(attention);
  const home = !query.search.trim() && (!query.status || query.status === 'all') && !query.group && !query.tag && !query.framework && !query.module;
  const statusGroups = query.module || query.group;
  const sections = new Map<string, DesignEntry[]>();
  for (const row of selected) {
    const key = statusGroups ? designStatus(row) : folderOf(row);
    if (!sections.has(key)) sections.set(key, []);
    sections.get(key)!.push(row);
  }
  const draftHref = (entry: DesignEntry) => {
    const params = new URLSearchParams({ project: projectId, design: entry.id });
    if (query.system && query.module) { params.set('system', query.system); params.set('module', query.module); }
    else if (query.group) params.set('group', query.group);
    return '/design?' + params;
  };
  const openFolder = (key: string, scope?: DesignModuleRef) => onChange({ group: scope ? '' : key,
    system: scope?.systemId ?? query.system, module: scope?.moduleId ?? '', view: '' });
  const folderTitle = (key: string) => folders.get(key)?.name ?? key;
  const folderRequirements = (key: string) => requirements.filter(row => row.scope ? scopeKey(row.scope) === key : key === legacyBriefFolder(row.designKey));
  const populatedFolders = [...folders].filter(([key, row]) => row.entries.length || folderRequirements(key).length);
  const cardGrid = (rows: DesignEntry[]) => <div className={mode === 'cards' ? 'dw-card-grid' : 'dw-list'}>
    {rows.map(entry => <DesignCard key={entry.id} entry={entry} workspace={workspace} theme={theme} read={read[entry.id]} href={draftHref(entry)} onLarge={onLarge} />)}
  </div>;
  const filters = [
    ['status', query.status && query.status !== 'all' ? libraryStatuses.find(([id]) => id === query.status)?.[1] : ''],
    ['tag', query.tag && '#' + query.tag],
    ['framework', query.framework && (frameworks.find(row => row.id === query.framework)?.versions.at(-1)?.title ?? query.framework)],
  ].filter(([, label]) => label);
  const visibleFrameworkIds = new Set(system ? [system.framework, ...system.modules.filter(row => !module || row.id === module.id).map(row => row.framework),
    ...scoped.map(row => latestDesign(row).framework)] : frameworks.map(row => row.id));
  const visibleFrameworks = frameworks.filter(row => visibleFrameworkIds.has(row.id));
  const frameworkTiles = (overview: boolean) => visibleFrameworks.map(row => {
    const latest = row.versions.at(-1)!;
    const charter = charterOf(latest);
    const used = frameworkUses(row.id, workspace.designs.filter(entry => !examples.has(entry.id)));
    return <button type="button" key={row.id} className={'dw-surface ' + (overview ? 'dw-framework-card' : 'dw-fw-tile')} onClick={() => onFramework(row.id)}>
      <span className="dw-row"><FrameworkBadge id={row.id} version={latest.version} compact /><FrameworkStatus revision={latest} /></span>
      <strong>{latest.title}</strong>
      {overview ? <FrameworkOverview material={latest.material} revision={latest} used={used.length}
        outdated={used.filter(({ binding }) => binding.frameworkVersion !== undefined && binding.frameworkVersion < latest.version).length} />
        : <><small>{charter?.intent ?? '还没有写设计初衷'}</small><small>{used.length} 份稿件在用</small></>}
    </button>;
  });
  return <>
    <div className="dw-library-bar dw-row">
      <div className="dw-row">
        {frameworkList ? <><button type="button" className="ep-text-button" onClick={() => onChange({ view: '' })}>设计库</button><strong>框架</strong></>
          : <><button type="button" className="ep-text-button" onClick={() => onChange({ group: '', module: '', view: '' })}>全部文件夹</button>
            {(module || query.group) ? <strong>/ {module?.name ?? folderTitle(query.group)}</strong>
              : <small>{populatedFolders.length} 个文件夹 · {scoped.length} 份稿件</small>}</>}
        {systems.length > 0 && <select value={query.system} aria-label="所属系统" onChange={event => onChange({ system: event.target.value, module: '', group: '' })}>
          <option value="">全部系统</option>{systems.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select>}
        {system && <select value={query.module} aria-label="所属模块" onChange={event => onChange({ module: event.target.value, group: '' })}>
          <option value="">全部模块</option>{system.modules.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select>}
      </div>
      {!frameworkList && <div className="dw-tools dw-right">
        <label className="dw-search"><Search /><input aria-label="搜索稿件" placeholder="搜稿件、文件夹或 PR" value={query.search}
          onChange={event => onChange({ q: event.target.value })} /></label>
        <select value={query.status || 'all'} aria-label="状态" onChange={event => onChange({ status: event.target.value === 'all' ? '' : event.target.value, filter: '' })}>
          {libraryStatuses.map(([value, label]) => <option key={value} value={value}>{label}{value === 'attention' ? ' ' + scoped.filter(attention).length : ''}</option>)}
        </select>
        {tags.length > 0 && <select value={query.tag} aria-label="标签" onChange={event => onChange({ tag: event.target.value })}>
          <option value="">标签</option>{tags.map(value => <option key={value}>{value}</option>)}</select>}
        <div className="dw-segments" aria-label="稿件布局">
          <button aria-pressed={mode === 'cards'} type="button" onClick={() => onChange({ mode: '' })} aria-label="卡片墙"><Grid2X2 /></button>
          <button aria-pressed={mode === 'list'} type="button" onClick={() => onChange({ mode: 'list' })} aria-label="列表"><List /></button>
        </div>
      </div>}
      {!frameworkList && filters.length > 0 && <div className="dw-filter-chips" aria-label="已选筛选">
        {filters.map(([field, label]) => <button type="button" key={field} onClick={() => onChange(field === 'framework'
          ? { framework: '', frameworkFilter: '' } : field === 'status' ? { status: '', filter: '' } : { [field!]: '' })} aria-label={'清除 ' + label}>
          {label}<X size={12} /></button>)}
      </div>}
    </div>
    <div className="dw-gallery dw-library">
      {frameworkList ? (visibleFrameworks.length ? <div className="dw-card-grid">{frameworkTiles(true)}</div>
        : <p className="dw-placeholder">此范围还没有已登记的设计框架。</p>)
        : <>
          {home && pending.length > 0 && <section aria-label="等我处理">
            <h2>等我处理 <small>{pending.length}</small></h2>
            <ul className="dw-pending-list">{pending.map(entry => {
              const { title, version } = latestDesign(entry);
              const review = permissions.review ? openReviews(entry).find(row => permissions.steward || row.comment.author.id === permissions.actorId) : undefined;
              const canReview = entry.reviewRequested && permissions.review && (!entry.reviewers?.length || entry.reviewers.some(row => row.id === permissions.actorId));
              const href = draftHref(entry);
              return <li className="dw-surface" key={entry.id}>
                <Link className="ep-link" to={href}>{title}</Link><small>V{version}</small>
                {review ? <button type="button" className="ep-text-button" onClick={() => onReview(entry, review.comment, review.version)}>核对评审回复</button>
                  : canReview ? <Link className="ep-text-button" to={href}>查看评审稿</Link>
                  : entry.feedback?.some(row => row.status === 'open' && row.author.id !== permissions.actorId)
                    ? <Link className="ep-text-button" to={href + '&tab=delivery'}>查看待回复反馈</Link>
                    : <Link className="ep-text-button" to={href + '&tab=accept'}>检查不通过项</Link>}
              </li>;
            })}</ul>
          </section>}
          {home && selected.length > 0 && <section aria-label="最近更新"><h2>最近更新</h2>{cardGrid(selected.slice(0, 4))}</section>}
          {home && populatedFolders.length > 0 && <section aria-label="文件夹">
            <h2>文件夹 <small>{populatedFolders.length}</small></h2>
            <div className="dw-card-grid">{populatedFolders.map(([key, folder]) => {
              const active = folder.entries.filter(row => !['signed', 'frozen'].includes(designStatus(row))).length;
              const waiting = folder.entries.filter(attention).length;
              const shareCount = folderRequirements(key).length;
              return <button className="dw-folder dw-surface" type="button" key={key} onClick={() => openFolder(key, folder.scope)}>
                <span className="dw-folder-art" data-count={Math.min(4, folder.entries.length)}>
                  {folder.entries.slice(0, 4).map(row => <span key={row.id}><DesignCover projectId={projectId} version={latestDesign(row)} theme={theme} thumbnail /></span>)}
                  {!folder.entries.length && <span className="dw-mini-empty"><Folder size={20} /></span>}
                  {!!waiting && <small>{waiting} 件等我处理</small>}
                </span>
                <span className="dw-folder-title"><Folder size={15} /><strong>{folder.name}</strong><small>{folder.entries.length} 份</small></span>
                <span className="dw-folder-meta">{active > 0 && <small>{active} 份进行中</small>}
                  {shareCount > 0 && <small>{shareCount} 项需求</small>}
                  {folder.entries[0] && <small>{designDate(latestDesign(folder.entries[0]).createdAt)}更新</small>}</span>
              </button>;
            })}</div>
          </section>}
          {!home && <>
            {module?.note && <p className="dw-muted">{module.note}</p>}
            {statusGroups && <DesignRequirementList workspace={workspace} requirements={folderRequirements(module && system ? scopeKey({ systemId: system.id, moduleId: module.id }) : query.group)} />}
            {!selected.length && <p className="dw-placeholder">这个范围没有匹配的稿件。</p>}
            {[...sections].map(([key, rows]) => <section key={key}>
              <h2>{statusGroups ? statusNames[key as keyof typeof statusNames] : <button type="button" className="ep-text-button"
                onClick={() => openFolder(key, folders.get(key)?.scope)}>{folderTitle(key)}</button>} <small>{rows.length}</small></h2>
              {cardGrid(rows)}
            </section>)}
          </>}
          {(home || module) && visibleFrameworks.length > 0 && <section className="dw-fw-strip" aria-label="本项目框架">
            <h2>{module ? '适用框架' : '本项目框架'} <small>{visibleFrameworks.length}</small></h2><div>{frameworkTiles(false)}</div>
          </section>}
          {home && !populatedFolders.length && !selected.length && !visibleFrameworks.length && <p className="dw-placeholder">{system ? '此系统还没有稿件。' : '此项目还没有稿件。'}可以发布第一版设计。</p>}
        </>}
    </div>
  </>;
}
