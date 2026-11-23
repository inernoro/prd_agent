import { Folder, Grid2X2, Layers, List, Maximize, MessageSquare, Search, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { DesignComment, DesignEntry, DesignModuleRef, DesignTheme, DesignVersion, DesignViewerState, DesignWorkspace } from '../../../../src/shared/design-workspace';
import { DesignFrame } from './DesignCanvas';
import { charterOf, FrameworkBadge, FrameworkOverview, FrameworkStatus, frameworkUses } from './DesignFramework';
import { DesignRequirementList } from './DesignRequirements';
import { latestDesignFeedbackAt } from '../../../../src/shared/design-workspace';
import { designArtifact, designDate, designFeedbackAwaitsViewer, designPublisherLabel, designStatus, failedBaseline, isNewDesignRequirement, latestDesign, legacyRequirementGroup, newDesignLabel, openReviews, scopeKey, statusNames } from './design-ui';

export const libraryStatuses = [
  ['all', '全部状态'], ['attention', '等我处理'], ['review', statusNames.review], ['failed', statusNames.failed],
  ['draft', statusNames.draft], ['passed', statusNames.passed],
] as const;
const legacyStatuses = ['active', 'signed', 'frozen'];
export const libraryStatus = (value: string | null) =>
  value && (libraryStatuses.some(([id]) => id === value) || legacyStatuses.includes(value)) ? value : '';

type LibraryQuery = {
  search: string; group: string; status: string; tag: string; framework: string; system: string; module: string;
};
const normalize = (value: string) => value.normalize('NFKC').toLowerCase();

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
  entry: DesignEntry; workspace: DesignWorkspace; viewer: DesignViewerState; theme: DesignTheme; href: string;
  onLarge: (entry: DesignEntry, version: DesignVersion) => void;
  task?: CardTask;
};
type CardTask = { label: string; href: string } | { label: string; open: () => void };

function DesignCard({ entry, workspace, viewer, theme, href, onLarge, task }: CardProps) {
  const version = latestDesign(entry);
  const status = designStatus(entry);
  const failed = failedBaseline(entry);
  const action = task ?? (failed === undefined ? undefined : { label: '验收未通过', href: href + '&tab=accept&version=' + failed });
  const target = action && 'href' in action ? action.href : href;
  const unread = newDesignLabel(entry, viewer);
  const unreadFeedback = latestDesignFeedbackAt(entry) > (viewer.designs?.[entry.id]?.feedbackAt ?? viewer.firstVisitAt ?? viewer.lastVisitAt ?? '');
  const framework = workspace.frameworks.find(row => row.id === version.framework);
  return <article className="dw-design-card" data-state={status}>
    <div className="dw-thumb">
      <DesignCover projectId={workspace.projectId} version={version} theme={theme} />
      {action && 'open' in action
        ? <button className="dw-card-cover" type="button" aria-label={'打开稿件 ' + version.title} aria-description={action.label} onClick={action.open} />
        : <Link className="dw-card-cover" to={target}
          aria-label={'打开稿件 ' + version.title} aria-description={action?.label} />}
      {unread ? <span className="dw-card-new">{unread}</span>
        : unreadFeedback && <Link className="dw-card-new" to={href + '&tab=delivery&part=feedback'}>新反馈</Link>}
      <button className="ep-button dw-card-screen" type="button" aria-label={'大屏查看 ' + version.title}
        onClick={() => onLarge(entry, version)}><Maximize />大屏</button>
    </div>
    <footer>
      <div className="dw-card-heading">
        <Link className="dw-card-title" to={target} title={version.title}>{version.title}</Link>
      </div>
      <div className="dw-card-meta">
        <span className="dw-status" data-state={status}>{statusNames[status]}</span>
        <time dateTime={version.createdAt}>{designDate(version.createdAt)}</time>
      </div>
      <div className="dw-card-provenance">
        <span className="dw-card-person" title={designPublisherLabel(version.publisher.label)}>{designPublisherLabel(version.publisher.label).slice(0, 1)}</span>
        <code>V{version.version}</code>
        {entry.comments.length > 0 && <small className="dw-card-comments"><MessageSquare />{entry.comments.length}</small>}
        <span className="dw-card-framework">{framework
          ? <FrameworkBadge id={framework.id} version={version.frameworkVersion} latest={framework.versions.at(-1)?.version} />
          : <span className="dw-fw-badge" data-missing>未绑定框架</span>}</span>
      </div>
    </footer>
  </article>;
}

export function DesignLibrary({ workspace, query, onChange, mode, theme, viewer, frameworkList, onFramework, onReview, onLarge, headerActions }: {
  workspace: DesignWorkspace; query: LibraryQuery; onChange: (fields: Record<string, string>) => void;
  mode: 'cards' | 'list'; theme: DesignTheme; viewer: DesignViewerState; frameworkList: boolean;
  onFramework: (id: string) => void;
  onReview: (entry: DesignEntry, comment: DesignComment, version: DesignVersion) => void; onLarge: CardProps['onLarge'];
  headerActions?: ReactNode;
}) {
  const { frameworks, permissions, projectId } = workspace;
  const systems = workspace.systems ?? [];
  const requirements = workspace.requirements ?? [];
  const exampleVersions = new Set(frameworks.flatMap(row => row.versions.flatMap(revision => {
    const example = charterOf(revision)?.example;
    return example ? [example.designId + '/' + example.version] : [];
  })));
  const designBriefs = new Set(requirements.map(row => row.designKey));
  const drafts = workspace.designs.filter(row => !exampleVersions.has(row.id + '/' + latestDesign(row).version)
    || row.reviewRequested || row.pullRequest || row.frozen !== undefined || designBriefs.has(row.designKey ?? '')).sort((a, b) =>
    latestDesign(b).createdAt.localeCompare(latestDesign(a).createdAt) || a.id.localeCompare(b.id));
  const system = systems.find(row => row.id === query.system);
  const module = system?.modules.find(row => row.id === query.module);
  const systemModules = systems.flatMap(owner => owner.modules.map(row => ({ owner, module: row })));
  const tags = [...new Set(drafts.flatMap(row => latestDesign(row).tags))].sort();
  const scopeMatches = (ref?: DesignModuleRef) => (!query.system || ref?.systemId === query.system)
    && (!query.module || ref?.moduleId === query.module);
  const inScope = (entry: DesignEntry) => scopeMatches(entry.scope) || entry.scope?.related?.some(scopeMatches);
  const tasks = new Map<string, CardTask>();
  for (const entry of drafts) {
    const head = latestDesign(entry);
    const href = draftHref(entry);
    const canManage = permissions.steward || head.publisher.id === permissions.actorId;
    const review = permissions.review ? openReviews(entry).find(row => permissions.steward || row.comment.author.id === permissions.actorId) : undefined;
    const canReview = entry.reviewRequested && permissions.review && (!entry.reviewers?.length || entry.reviewers.some(row => row.id === permissions.actorId));
    const failed = canManage ? failedBaseline(entry) : undefined;
    if (review) tasks.set(entry.id, { label: '核对评审回复', open: () => onReview(entry, review.comment, review.version) });
    else if (canReview) tasks.set(entry.id, { label: '评审 V' + head.version, href });
    else if (permissions.feedback && entry.feedback?.some(row => designFeedbackAwaitsViewer(entry, row, permissions.actorId))) {
      tasks.set(entry.id, { label: '处理反馈', href: href + '&tab=delivery' });
    } else if (failed !== undefined) tasks.set(entry.id, { label: '验收未通过', href: href + '&tab=accept&version=' + failed });
  }
  const attention = (entry: DesignEntry) => tasks.has(entry.id);
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
  const requirementFolder = (brief: typeof requirements[number]) => brief.scope ? scopeKey(brief.scope) : legacyRequirementGroup(brief, drafts);
  for (const brief of requirements) {
    if (brief.scope || !scopeMatches(brief.scope)) continue;
    const key = requirementFolder(brief);
    if (!folders.has(key)) folders.set(key, { name: key, entries: [] });
  }
  const scoped = drafts.filter(inScope);
  const selected = scoped.filter(row => {
    const head = latestDesign(row);
    const state = designStatus(row);
    const matchesStatus = query.status === 'attention' ? attention(row)
      : query.status === 'active' ? Boolean(row.pullRequest && state !== 'review' && state !== 'passed')
      : query.status === 'frozen' ? row.frozen !== undefined
      : query.status === 'signed' ? state === 'passed'
      : !query.status || query.status === 'all' || state === query.status;
    return matchesStatus && (!query.group || groupOf(row) === query.group || folderOf(row) === query.group)
      && (!query.tag || head.tags.includes(query.tag)) && (!query.framework || head.framework === query.framework)
      && normalize([head.title, row.id, groupOf(row), folders.get(folderOf(row))?.name, ...head.tags,
        row.pullRequest ? 'PR #' + row.pullRequest : ''].join(' ')).includes(normalize(query.search.trim()));
  });
  const pending = selected.filter(attention);
  const recent = selected.filter(row => !attention(row)).slice(0, 4);
  const awaitingDraft = (row: typeof requirements[number]) => !drafts.some(entry => entry.designKey === row.designKey);
  const pendingBriefs = permissions.write ? requirements.filter(row => scopeMatches(row.scope) && awaitingDraft(row)
    && (!row.assignee || row.assignee.id === permissions.actorId)) : [];
  const pendingTotal = pending.length + pendingBriefs.length;
  const home = !query.search.trim() && (!query.status || query.status === 'all') && !query.group && !query.tag && !query.framework && !query.module;
  const statusGroups = query.module || query.group;
  const sections = new Map<string, DesignEntry[]>();
  for (const row of selected) {
    const key = statusGroups ? designStatus(row) : folderOf(row);
    if (!sections.has(key)) sections.set(key, []);
    sections.get(key)!.push(row);
  }
  function draftHref(entry: DesignEntry) {
    const params = new URLSearchParams({ project: projectId, design: entry.id });
    if (query.system && query.module) { params.set('system', query.system); params.set('module', query.module); }
    else if (query.group) params.set('group', query.group);
    return '/design?' + params;
  }
  const openFolder = (key: string, scope?: DesignModuleRef) => onChange({ group: scope ? '' : key,
    system: scope?.systemId ?? query.system, module: scope?.moduleId ?? '', view: '' });
  const folderTitle = (key: string) => folders.get(key)?.name ?? key;
  const folderRequirements = (key: string) => requirements.filter(row => requirementFolder(row) === key);
  const populatedFolders = [...folders].filter(([key, row]) => row.entries.length || folderRequirements(key).length);
  const layout = mode === 'cards' ? 'dw-card-grid' : 'dw-list';
  const renderCard = (entry: DesignEntry) => <DesignCard key={entry.id} entry={entry} workspace={workspace}
    theme={theme} viewer={viewer} href={draftHref(entry)} onLarge={onLarge} task={tasks.get(entry.id)} />;
  const cardGrid = (rows: DesignEntry[]) => <div className={layout}>{rows.map(renderCard)}</div>;
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
    const used = frameworkUses(row.id, drafts);
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
        <h1>{frameworkList ? '框架' : module?.name ?? (query.group ? folderTitle(query.group) : '设计')}</h1>
        {!frameworkList && (module || query.group) && <button type="button" className="ep-text-button"
          onClick={() => onChange({ group: '', module: '', view: '' })}>全部文件夹</button>}
        {systems.length > 0 && <select value={query.system} aria-label="所属系统" onChange={event => onChange({ system: event.target.value, module: '', group: '' })}>
          <option value="">全部系统</option>{systems.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select>}
        {system && <select value={query.module} aria-label="所属模块" onChange={event => onChange({ module: event.target.value, group: '' })}>
          <option value="">全部模块</option>{system.modules.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select>}
        {!frameworkList && visibleFrameworks.length > 0 && <button type="button" className="ep-text-button"
          onClick={() => onChange({ view: 'frameworks', framework: '', frameworkFilter: '' })}>框架 {visibleFrameworks.length} 套</button>}
      </div>
      {!frameworkList && <div className="dw-tools dw-right">
        <label className="dw-search"><Search /><input aria-label="搜索稿件" placeholder="搜稿件、文件夹或 PR" value={query.search}
          onChange={event => onChange({ q: event.target.value })} /></label>
        <select value={query.status || 'all'} aria-label="状态" onChange={event => onChange({ status: event.target.value === 'all' ? '' : event.target.value, filter: '' })}>
          {libraryStatuses.map(([value, label]) => <option key={value} value={value}>{label}{value === 'attention' ? ' ' + (scoped.filter(attention).length + pendingBriefs.length) : ''}</option>)}
          {legacyStatuses.includes(query.status) && <option value={query.status}>历史筛选</option>}
        </select>
        {tags.length > 0 && <select value={query.tag} aria-label="标签" onChange={event => onChange({ tag: event.target.value })}>
          <option value="">标签</option>{tags.map(value => <option key={value}>{value}</option>)}</select>}
        <div className="dw-segments" aria-label="稿件布局">
          <button aria-pressed={mode === 'cards'} type="button" onClick={() => onChange({ mode: '' })} aria-label="卡片墙"><Grid2X2 /></button>
          <button aria-pressed={mode === 'list'} type="button" onClick={() => onChange({ mode: 'list' })} aria-label="列表"><List /></button>
        </div>
        {headerActions}
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
          {(home && (scoped.length > 0 || pendingTotal > 0)
            || (query.status === 'attention' && !query.tag && !query.framework && !query.group && !query.module && pendingTotal > 0))
            && <section aria-label="等你处理">
            <h2>等你处理 <small>{pendingTotal}</small></h2>
            {pendingTotal ? <div className={layout}>
              {pending.map(renderCard)}
              {pendingBriefs.map(brief => <Link className="dw-design-card dw-brief-card" key={brief.designKey}
                to={'/design?' + new URLSearchParams({ project: projectId, brief: brief.designKey })}>
                <span className="dw-thumb">
                  {isNewDesignRequirement(brief, viewer) && <small className="dw-card-new">新需求</small>}
                  <Folder size={24} aria-hidden />
                </span>
                <footer>
                  <div className="dw-card-heading"><strong className="dw-card-title">{brief.title}</strong></div>
                  <div className="dw-card-meta"><span className="dw-status">待出稿</span><time dateTime={brief.sharedAt}>{designDate(brief.sharedAt)}</time></div>
                  <div className="dw-card-provenance"><small>{brief.assignee?.label ?? '等设计方认领'}</small></div>
                </footer>
              </Link>)}
            </div> : <p className="dw-muted">没有等你处理的事项。</p>}
          </section>}
          {home && recent.length > 0 && <section aria-label="最近更新"><h2>最近更新</h2>{cardGrid(recent)}</section>}
          {home && populatedFolders.length > 0 && <section aria-label="文件夹">
            <h2>文件夹 <small>{populatedFolders.length}</small></h2>
            <div className="dw-card-grid">{populatedFolders.map(([key, folder]) => {
              const waiting = folder.entries.filter(attention).length;
              const waitingDraft = folderRequirements(key).filter(awaitingDraft).length;
              const newVersions = folder.entries.filter(row => newDesignLabel(row, viewer)).length;
              return <button className="dw-folder dw-surface" type="button" key={key} onClick={() => openFolder(key, folder.scope)}>
                <span className="dw-folder-art" data-count={Math.min(4, folder.entries.length)}>
                  {folder.entries.slice(0, 4).map(row => <span key={row.id}><DesignCover projectId={projectId} version={latestDesign(row)} theme={theme} thumbnail /></span>)}
                  {!folder.entries.length && <span className="dw-mini-empty"><Folder size={20} /></span>}
                  {newVersions > 0 && <small className="dw-card-new">{newVersions} 份有新版本</small>}
                </span>
                <span className="dw-folder-title"><Folder size={15} /><strong>{folder.name}</strong><small>{folder.entries.length} 份</small></span>
                <span className="dw-folder-meta">{waiting > 0 && <small>{waiting} 件等我处理</small>}
                  {waitingDraft > 0 && <small>{waitingDraft} 份待出稿</small>}
                  {folder.entries[0] && <small>{designDate(latestDesign(folder.entries[0]).createdAt)}更新</small>}</span>
              </button>;
            })}</div>
          </section>}
          {!home && <>
            {module?.note && <p className="dw-muted">{module.note}</p>}
            {statusGroups && <DesignRequirementList workspace={workspace} viewer={viewer}
              requirements={folderRequirements(module && system ? scopeKey({ systemId: system.id, moduleId: module.id }) : query.group)} />}
            {!selected.length && <p className="dw-placeholder">这个范围没有匹配的稿件。</p>}
            {[...sections].map(([key, rows]) => <section key={key}>
              <h2>{statusGroups ? statusNames[key as keyof typeof statusNames] : <button type="button" className="ep-text-button"
                onClick={() => openFolder(key, folders.get(key)?.scope)}>{folderTitle(key)}</button>} <small>{rows.length}</small></h2>
              {cardGrid(rows)}
            </section>)}
          </>}
          {module && visibleFrameworks.length > 0 && <section className="dw-fw-strip" aria-label="适用框架">
            <h2>适用框架 <small>{visibleFrameworks.length}</small></h2><div>{frameworkTiles(false)}</div>
          </section>}
          {home && !populatedFolders.length && !selected.length && <p className="dw-placeholder">{system ? '此系统还没有稿件。' : '此项目还没有稿件。'}可以发布第一版设计。</p>}
        </>}
    </div>
  </>;
}
