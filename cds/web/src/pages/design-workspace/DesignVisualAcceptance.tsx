import { useDesignThumbnails } from './DesignGallery';
import { useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useTheme } from '@/lib/theme';
import { designDemoImplementationPath, designSlots, designViewports, type DesignCell, type DesignEntry, type DesignRun,
  type DesignScreen, type DesignSlot, type DesignVersion } from '../../../../src/shared/design-workspace';
import { designComparisonStatus, designMethodPlanEnabled, designMethodVisualStatus, designObjectivePlanEnabled } from '../../../../src/shared/design-methods';
import { concreteVisualEvidence, designSceneCoverage, designVisualCheckStatus, designVisualKey, designVisualReference, designVisualRowForSlot, designVisualRuleShot, designVisualSlots,
  designVisualStandard, designVisualStatus, visualSlotTheme, type DesignVisualChecks, type DesignVisualRow, type DesignVisualStatus } from '../../../../src/shared/design-visual';
import { cellNames, designArtifact, designDate, designPublisherLabel, ruleModes, slotNames, type DesignCommand } from './design-ui';

const verdictNames: Record<DesignVisualStatus, string> = {
  passed: '通过', failed: '有问题', missing: '缺证据', no_image: '缺实拍', no_reference: '缺对照图', unverified: '未运行',
};
const checkNames = { passed: '通过', failed: '有问题', missing: '缺证据' } as const;
const columns = ['画面', '验收方式', '对照图', '实现图', '结论'];

function reviewRow(version: DesignVersion, screen: DesignScreen, slot: DesignSlot, visualOnly: boolean, run?: DesignRun,
  sceneCoverage?: ReturnType<typeof designSceneCoverage>) {
  const record = designVisualRowForSlot(screen, slot, run, sceneCoverage);
  const rules = version.acceptance.filter(rule => rule.screenId === screen.id && rule.slots.includes(slot)).map(rule => ({
    rule, cell: run?.cells.find(cell => cell.itemId === rule.id && cell.slot === slot),
  }));
  const ruleShot = record?.imageId ? undefined : designVisualRuleShot(version, screen, slot, run);
  const implementation = record?.imageId ?? ruleShot?.imageId;
  const reference = designVisualReference(version, screen.id, slot, record);
  const checks = designVisualStandard.map(([id, name]) => ({ id, name, status: designVisualCheckStatus(id, record?.checks[id]) }));
  const failed = checks.filter(check => check.status === 'failed');
  const splitMethods = designMethodPlanEnabled(version);
  const comparableRules = visualOnly ? [] : splitMethods ? rules.filter(({ rule }) => rule.how === 'screenshot') : rules;
  let verdict = visualOnly ? designMethodVisualStatus(screen, slot, run, sceneCoverage)
    : splitMethods ? designComparisonStatus(version, screen, slot, run) : designVisualStatus(version, screen, slot, run, sceneCoverage);
  if (comparableRules.some(({ cell }) => cell?.status === 'failed')) verdict = 'failed';
  else if (verdict === 'passed' && comparableRules.some(({ cell }) => cell?.status !== 'passed')) verdict = 'missing';
  if (verdict === 'no_image' && implementation) verdict = visualOnly || reference ? 'missing' : 'no_reference';
  return { screen, record, rules, checks, failed, verdict, reference, implementation, ruleShot };
}
type ReviewRow = ReturnType<typeof reviewRow>;

export function DesignVisualAcceptance({ entry, version: declared, run, busy, writable, command, onRule, program, visualOnly = false }: {
  entry: DesignEntry; version: DesignVersion; run?: DesignRun; busy: boolean; writable: boolean;
  command: DesignCommand; onRule: (cell: DesignCell) => void; visualOnly?: boolean;
  program?: { capture: boolean; recheck: boolean; actor?: string };
}) {
  const thumbnails = useDesignThumbnails(entry.projectId, declared, entry.id);
  const version = thumbnails.renders ? { ...declared, renders: thumbnails.renders } : declared;
  const [params, setParams] = useSearchParams();
  const { theme } = useTheme();
  const objective = designObjectivePlanEnabled(version);
  const [preferredSlot, preferSlot] = useState<DesignSlot>();
  const viewport = typeof window !== 'undefined' && window.matchMedia('(max-width: 47.9375rem)').matches ? 'phone' : 'desktop';
  const [filter, setFilter] = useState<'todo' | 'all'>('todo');
  const [selected, setSelected] = useState<string>();
  const opened = objective ? params.get('compare-screen') : selected;
  const selectedScreen = version.screens.find(screen => screen.id === opened);
  const savedSlot = objective ? designSlots.find(value => value === params.get('compare-slot')) : undefined;
  const candidateSlot: DesignSlot = savedSlot ?? preferredSlot ?? `${viewport}-${theme}`;
  const matchingSlots = selectedScreen ? designVisualSlots(selectedScreen) : undefined;
  const slot = matchingSlots?.includes(candidateSlot) ? candidateSlot : matchingSlots?.[0] ?? candidateSlot;
  const setSlot = (next: DesignSlot) => {
    preferSlot(next);
    if (objective) setParams(former => {
      const value = new URLSearchParams(former);
      value.set('compare-slot', next);
      return value;
    }, { replace: true });
  };
  const opener = useRef<HTMLButtonElement | null>(null);
  const sceneCoverage = designSceneCoverage(version, run);
  const rows = version.screens.filter(screen => designVisualSlots(screen).includes(slot))
    .map(screen => reviewRow(version, screen, slot, visualOnly, run, sceneCoverage));
  const pending = rows.filter(row => row.verdict !== 'passed'
    || program && !run?.programEvidence?.[designVisualKey(row.screen.id, slot)]?.review?.matched);
  const shown = filter === 'todo' ? pending : rows;
  const row = rows.find(row => row.screen.id === opened);
  const snapshot = (artifactId: string) => designArtifact(entry.projectId, artifactId);
  const open = (event: MouseEvent<HTMLButtonElement>, screenId: string) => {
    opener.current = event.currentTarget;
    if (!objective) setSelected(screenId);
    else setParams(former => {
      const value = new URLSearchParams(former);
      value.set('compare-screen', screenId);
      value.set('compare-slot', slot);
      return value;
    });
  };
  const close = () => {
    if (!objective) setSelected(undefined);
    else setParams(former => {
      const value = new URLSearchParams(former);
      value.delete('compare-screen');
      return value;
    }, { replace: true });
  };
  return <>
    <div className="dw-vs-tools">
      <div className="dw-segments" role="group" aria-label="视口和主题">
        {designSlots.map(value => <button key={value} type="button" aria-pressed={slot === value}
          onClick={() => setSlot(value)}>{slotNames[value]}</button>)}
      </div>
      <div className="dw-dl-seg" role="group" aria-label="筛选画面">
        <button type="button" aria-pressed={filter === 'todo'} onClick={() => setFilter('todo')}>要看的 {pending.length}</button>
        <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部 {rows.length}</button>
      </div>
    </div>
    {shown.length ? <div className="dw-vs-table" role="table" aria-label="逐画面对照">
      <div className="dw-vs-row dw-vs-head" role="row">{columns.map(label => <span role="columnheader" key={label}>{label}</span>)}</div>
      {shown.map(row => {
        const proof = run?.programEvidence?.[designVisualKey(row.screen.id, slot)];
        const hasDemo = program && designDemoImplementationPath(row.screen);
        const action = !proof && program?.capture ? 'acceptance.capture'
          : proof && !proof.review && program?.recheck && proof.by !== program.actor ? 'acceptance.recheck' : undefined;
        return <div className="dw-vs-row" key={row.screen.id} role="row" data-screen={row.screen.id} data-verdict={row.verdict}
          data-compare-slot={objective ? slot : undefined}>
        <div role="cell" className="dw-vs-name">
          <strong>{row.screen.name}</strong><small>{slotNames[slot]} · {row.screen.impl ? <code>{row.screen.impl}</code>
            : hasDemo ? '演示数据场景' : '未绑定实现地址'}</small>
        </div>
        <div role="cell" className="dw-vs-method">
          {row.rules.map(({ rule, cell }) => <span className="dw-vs-chip" key={rule.id} data-status={cell?.status ?? 'unverified'}
            title={`${rule.rule} · ${ruleModes[rule.how]} · ${cellNames[cell?.status ?? 'unverified']}`}>{rule.id}</span>)}
          <small>通用 {designVisualStandard.length} 项 · {row.checks.filter(check => check.status === 'passed').length} 通过 · {row.failed.length} 有问题 · {row.checks.filter(check => check.status === 'missing').length} 缺证据</small>
          {row.failed.map(check => <small className="dw-vs-fail" key={check.id}>{check.id} {check.name} · {row.record?.checks[check.id]?.evidence}</small>)}
        </div>
        <div role="cell"><button type="button" className="dw-vs-shot" data-missing={!row.reference || undefined}
          aria-label={`看 ${row.screen.name} 对照图`} onClick={event => open(event, row.screen.id)}>
          {row.reference ? <img src={snapshot(row.reference)} alt="" loading="lazy" /> : <span>{visualOnly ? '未附对照图' : '缺对照图'}</span>}
        </button></div>
        <div role="cell"><button type="button" className="dw-vs-shot" data-missing={!row.implementation || undefined}
          aria-label={`看 ${row.screen.name} 实现图`} onClick={event => open(event, row.screen.id)}>
          {row.implementation ? <img src={snapshot(row.implementation)} alt="" loading="lazy" /> : <span>缺实拍</span>}
        </button></div>
        <div role="cell" className="dw-vs-verdict">
          <span className="dw-status" data-state={row.verdict}>{verdictNames[row.verdict]}</span>
          {!row.reference && !visualOnly && <small>{program ? '待同条件截图' : '对照图由设计方提供'}</small>}
          {!row.implementation && <small>{row.screen.impl || hasDemo ? program ? '待程序实拍' : '实现方补实拍' : '实现方绑定画面'}</small>}
          {proof && <small>程序实拍 · {proof.commit.slice(0, 8)} · {proof.review ? proof.review.matched ? '复验一致' : '复验有差异' : '待设计方复验'}</small>}
          {proof?.dataset && <small title={proof.dataset}>数据集 {proof.dataset.slice(0, 12)}</small>}
          {run && (row.screen.impl || hasDemo) && action && <button type="button" className="ep-text-button" disabled={busy}
            onClick={() => void command(action, { designId: entry.id, runId: run.id, screenId: row.screen.id, slot })}>
            {action === 'acceptance.capture' ? '用演示数据截' : '独立复验'}
          </button>}
          <button type="button" className="ep-text-button" data-action="visual-open" aria-label={`逐项对图 · ${row.screen.name}`}
            aria-haspopup="dialog" aria-expanded={row.screen.id === opened}
            onClick={event => open(event, row.screen.id)}>逐项对图</button>
        </div>
      </div>; })}
    </div> : <p className="dw-vs-muted">{rows.length ? '这一视口和主题的画面均已通过。' : '这一视口和主题没有画面。'}</p>}
    {row && <VisualComparison key={designVisualKey(row.screen.id, slot)} entry={entry} version={version} row={row}
      slot={slot} busy={busy} run={run} writable={writable} command={command} close={close}
      restoreFocus={() => (opener.current ?? document.querySelector<HTMLButtonElement>('.dw-vs-tools button[aria-pressed=true]'))?.focus()}
      onRule={cell => { opener.current = null; close(); onRule(cell); }} />}
  </>;
}

async function screenshot(file: File, viewport: DesignScreen['viewport']) {
  if (file.type !== 'image/png' || file.size > 1.5 * 1024 * 1024) throw new Error('请提供 1.5 MiB 以内的 PNG 截图');
  const { width, height } = designViewports[viewport];
  const bitmap = await createImageBitmap(file);
  const matches = bitmap.width === width && bitmap.height === height;
  bitmap.close();
  if (!matches) throw new Error(`本画面需要 ${width} × ${height} 的截图`);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('无法读取截图'));
    reader.readAsDataURL(file);
  });
}

function VisualComparison({ entry, version, row, slot, busy, run, writable, command, close, restoreFocus, onRule }: {
  entry: DesignEntry; version: DesignVersion; row: ReviewRow; slot: DesignSlot; busy: boolean; run?: DesignRun; writable: boolean;
  command: DesignCommand; close: () => void; restoreFocus: () => void; onRule: (cell: DesignCell) => void;
}) {
  const [mode, setMode] = useState<'pair' | 'overlay'>('pair');
  const [mix, setMix] = useState(50);
  const [edit, setEdit] = useState<'images' | 'checks'>();
  const [uploading, setUploading] = useState(false);
  const [issue, setIssue] = useState('');
  const { screen, record } = row;
  const reference = row.reference && designArtifact(entry.projectId, row.reference);
  const implementation = row.implementation && designArtifact(entry.projectId, row.implementation);
  const both = Boolean(reference && implementation);
  const { width, height } = designViewports[screen.viewport];
  const theme = visualSlotTheme(slot);
  const canEdit = !!run && writable;
  const publishedReference = !!version.renders?.[screen.id]?.[theme];
  const previewPath = `/design?${new URLSearchParams({ project: entry.projectId, design: entry.id,
    version: String(version.version), tab: 'preview', screen: screen.id })}`;
  const send = async (fields: Record<string, unknown>) => {
    if (!run) return false;
    return command('acceptance.visual', { designId: entry.id, runId: run.id, commit: run.commit, screenId: screen.id, slot, ...fields });
  };
  const openEditor = (next: typeof edit) => { setIssue(''); setEdit(next); };
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const selectedReference = form.get('reference');
    const selectedImplementation = form.get('implementation');
    const referenceFile = selectedReference instanceof File && selectedReference.size ? selectedReference : undefined;
    const implementationFile = selectedImplementation instanceof File && selectedImplementation.size ? selectedImplementation : undefined;
    if (!referenceFile && !implementationFile) { setIssue('请选择一张要补交的图片。'); return; }
    setUploading(true);
    setIssue('');
    try {
      const [referenceImage, image] = await Promise.all([referenceFile && screenshot(referenceFile, screen.viewport),
        implementationFile && screenshot(implementationFile, screen.viewport)]);
      if (await send({ checks: {}, ...(referenceImage ? { referenceImage } : {}),
        ...(image ? { image, measured: { width, height, theme, path: screen.impl } } : {}) })) {
        setMode('pair');
        setEdit(undefined);
      }
    } catch (error) { setIssue(error instanceof Error ? error.message : '无法读取截图'); }
    finally { setUploading(false); }
  }
  async function saveChecks(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const checks: DesignVisualChecks = {};
    for (const [id] of designVisualStandard) {
      const status = form.get(id);
      const evidence = String(form.get(`${id}-evidence`) ?? '').trim();
      if (status !== 'passed' && status !== 'failed' && status !== 'missing') continue;
      if (status !== 'missing' && !concreteVisualEvidence(id, evidence)) {
        setIssue(`${id} 请写具体区域或测量结果。未核实可标为缺证据。`);
        return;
      }
      checks[id] = { status, evidence };
    }
    setIssue('');
    if (await send({ checks })) setEdit(undefined);
  }
  const figure = (label: string, src: string | undefined, missing: string) => <figure>
    <figcaption>{label}</figcaption>
    {src ? <a href={src} target="_blank" rel="noreferrer"><img width={width} height={height} src={src} alt={`${screen.name} ${label}`} /></a>
      : <div className="dw-vc-empty" style={{ aspectRatio: width / height }}>{missing}</div>}
  </figure>;
  const closeEditor = <button type="button" className="ep-button" onClick={() => openEditor(undefined)} disabled={busy || uploading}>取消</button>;
  return <Dialog open onOpenChange={open => { if (!open && !busy && !uploading) close(); }}>
    <DialogContent className="dw-modal dw-surface dw-vc" onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(); }}>
      <DialogTitle>{screen.name} · {slotNames[slot]}</DialogTitle>
      <DialogDescription>V{version.version} · {width} × {height}{run ? ` · ${run.target === 'installed' ? '主用 CDS' : `PR #${run.pullRequest}`} · 提交 ${run.commit.slice(0, 8)}` : ''}
        {screen.impl ? ` · ${screen.impl}` : ' · 未绑定实现地址'}。对照图和实拍须使用同视口、主题、状态和数据规模。</DialogDescription>
      <div className="dw-vc-mode">
        <div className="dw-segments" role="group" aria-label="对照方式">
          <button type="button" aria-pressed={mode === 'pair'} onClick={() => setMode('pair')}>并排</button>
          <button type="button" aria-pressed={mode === 'overlay'} disabled={!both} onClick={() => setMode('overlay')}>叠加</button>
        </div>
        {mode === 'overlay' && <label className="dw-vc-mix">实现图透明度
          <input type="range" min="0" max="100" value={mix} onChange={event => setMix(Number(event.target.value))} />
        </label>}
        {!reference && <Link className="ep-link" to={previewPath}>打开稿件原型</Link>}
        {run && screen.impl && <a className="ep-link" href={new URL(screen.impl, run.previewUrl).href} target="_blank" rel="noreferrer">打开实现画面</a>}
        {canEdit && (!publishedReference || screen.impl) && <button type="button" className="ep-button" onClick={() => openEditor('images')}>补交图片</button>}
      </div>
      {mode === 'overlay' && reference && implementation ? <div className="dw-vc-overlay">
        <img width={width} height={height} src={reference} alt={`${screen.name} 对照图`} />
        <img width={width} height={height} src={implementation} alt={`${screen.name} 实现图`} style={{ opacity: mix / 100 }} />
      </div> : <div className="dw-vc-pair">
        {figure(record?.referenceImageId ? '对照图 · 本次补交' : '对照图 · 稿件', reference, '稿件没有这一视口的对照图')}
        {figure(row.ruleShot ? '实现图 · 验收项实拍' : '实现图 · 实拍', implementation, '缺实拍')}
      </div>}
      {canEdit && edit === 'images' && <form className="dw-vc-editor" onSubmit={event => void upload(event)}>
        <p>上传同主题、同状态和同数据规模的截图。更新图片后需重新记录检查。</p>
        {!publishedReference && <label>对照图 · 同版本原型<input type="file" name="reference" accept="image/png" /></label>}
        {screen.impl && <label>实现图 · 当前运行提交<input type="file" name="implementation" accept="image/png" /></label>}
        {issue && <p role="alert">{issue}</p>}
        <footer>{closeEditor}<button className="ep-button ep-button--primary" disabled={busy || uploading}>保存图片</button></footer>
      </form>}
      <h4>稿件验收项</h4>
      {row.rules.length ? <ul className="dw-vc-checks">{row.rules.map(({ rule, cell }) => <li key={rule.id} data-status={cell?.status ?? 'unverified'}>
        <code>{rule.id}</code><div><strong>{rule.rule} <small>{ruleModes[rule.how]}</small></strong>
          {rule.expected && <small>{rule.expected}</small>}{cell?.actual && <p>{cell.actual}</p>}
          {cell && <button type="button" className="ep-link" onClick={() => onRule(cell)}>看验收项证据</button>}
        </div><span className="dw-status" data-state={cell?.status ?? 'draft'}>{cellNames[cell?.status ?? 'unverified']}</span>
      </li>)}</ul> : <p className="dw-vs-muted">此画面没有单独的稿件验收项。</p>}
      <div className="dw-vc-standard">
        <h4>通用视觉检查 · 10 项</h4>
        {canEdit && edit !== 'checks' && <button type="button" className="ep-button" onClick={() => openEditor('checks')}>记录检查</button>}
      </div>
      {record && <p className="dw-vs-muted">{designPublisherLabel(record.by)} · {designDate(record.at)}</p>}
      {canEdit && edit === 'checks' ? <form onSubmit={event => void saveChecks(event)} className="dw-vc-editor">
        <p>记录对应区域、测量值或差异依据。图片或证据缺失时请标为缺证据。</p>
        <ul className="dw-vc-checks">{designVisualStandard.map(([id, name, how, expected]) => <li key={id}>
          <code>{id}</code><div><strong>{name} <small>{how}</small></strong><small>{expected}</small>
            <label>证据<textarea name={`${id}-evidence`} maxLength={2000} rows={2} defaultValue={record?.checks[id]?.evidence ?? ''} /></label></div>
          <select name={id} aria-label={`${id} ${name}结论`} defaultValue={designVisualCheckStatus(id, record?.checks[id])}>
            {Object.entries(checkNames).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select>
        </li>)}</ul>
        {issue && <p role="alert">{issue}</p>}
        <footer>{closeEditor}<button className="ep-button ep-button--primary" disabled={busy}>保存检查</button></footer>
      </form> : <VisualChecklist record={record} />}
    </DialogContent>
  </Dialog>;
}

function VisualChecklist({ record }: { record?: DesignVisualRow }) {
  return <ul className="dw-vc-checks">{designVisualStandard.map(([id, name, how, expected]) => {
    const check = record?.checks[id];
    const status = designVisualCheckStatus(id, check);
    return <li key={id} data-status={status}>
      <code>{id}</code><div><strong>{name} <small>{how}</small></strong><small>{expected}</small>
        {check?.evidence && <p>{check.evidence}</p>}</div>
      <span className="dw-status" data-state={status}>{checkNames[status]}</span>
    </li>;
  })}</ul>;
}
