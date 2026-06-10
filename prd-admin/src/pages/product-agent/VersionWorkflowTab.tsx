import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, FileSpreadsheet, HelpCircle, Loader2, Plus, Upload, X } from 'lucide-react';
import JSZip from 'jszip';
import {
  approveInitiation, completeRelease, createInitiation, createRelease, decideInitiation,
  importVersionWorkflow, listInitiations, listProductMembers, listReleases, listRequirements,
  listVersions, syncInitiationReview,
} from '@/services/real/productAgent';
import { uploadAttachment } from '@/services/real/aiToolbox';
import { createSubmission, getSubmission } from '@/services/real/reviewAgent';
import type { ProductInitiation, ProductMember, ProductRelease, ProductVersion, Requirement } from './types';

type MainTab = 'release' | 'initiation';
type ImportKind = 'initiation' | 'release';
const SCALE_LABEL = { major: '大版本', medium: '中版本', minor: '小版本' } as const;
const STATUS_LABEL: Record<string, string> = {
  draft: '草稿', review_pending: 'Agent 评审中', review_failed: '评审未通过',
  decision_pending: '待确认评审方式', owner_pending: '待负责人同意', approved: '已取得立项号',
  announcement_pending: '待填写上线公告', released: '已上线',
};

export function VersionWorkflowTab({ productId }: { productId: string }) {
  const [tab, setTab] = useState<MainTab>('release');
  const [initiations, setInitiations] = useState<ProductInitiation[]>([]);
  const [releases, setReleases] = useState<ProductRelease[]>([]);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [members, setMembers] = useState<ProductMember[]>([]);
  const [legacyVersions, setLegacyVersions] = useState<ProductVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<'initiation' | 'release' | 'temporary' | null>(null);
  const [importKind, setImportKind] = useState<ImportKind | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const [i, r, req, mem, old] = await Promise.all([
      listInitiations(productId), listReleases(productId), listRequirements(productId),
      listProductMembers(productId), listVersions(productId),
    ]);
    if (i.success) setInitiations(i.data.items);
    if (r.success) setReleases(r.data.items);
    if (req.success) setRequirements(req.data.items);
    if (mem.success) setMembers(mem.data.members);
    if (old.success) setLegacyVersions(old.data.items);
    setLoading(false);
  }, [productId]);

  useEffect(() => { void reload(); }, [reload]);
  const approved = useMemo(() => initiations.filter((item) => item.status === 'approved' && item.tCode), [initiations]);
  if (loading) return <div className="py-16 text-center text-sm text-white/40">正在加载版本流程...</div>;

  return <div className="flex flex-col gap-5">
    <div className="flex border-b border-white/10">
      <Tab active={tab === 'release'} onClick={() => setTab('release')}>上线</Tab>
      <Tab active={tab === 'initiation'} onClick={() => setTab('initiation')}>立项</Tab>
    </div>
    {tab === 'release' ? <>
      <div className="flex flex-wrap items-center gap-2">
        <Primary onClick={() => setDialog('release')} disabled={approved.length === 0}><Plus size={14} />申领上线号</Primary>
        <button onClick={() => setDialog('temporary')} className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">临时优化需求</button>
        <span className="group relative"><HelpCircle size={15} className="cursor-help text-white/35" />
          <span className="invisible absolute left-0 top-6 z-20 w-72 rounded-lg border border-white/10 bg-[#181a20] p-3 text-xs leading-5 text-white/65 shadow-xl group-hover:visible">
            月度常规计划外、紧急且工作量较小的优化。产品工作量原则上不超过 3 天，研发不超过 5 天；无需 T 号，按小版本自动审批。
          </span>
        </span>
        <Secondary onClick={() => setImportKind('release')}><Upload size={14} />导入历史上线</Secondary>
      </div>
      <ReleaseTable items={releases} requirements={requirements} members={members} onChanged={reload} />
    </> : <>
      <div className="flex gap-2">
        <Primary onClick={() => setDialog('initiation')}><Plus size={14} />立项</Primary>
        <Secondary onClick={() => setImportKind('initiation')}><Upload size={14} />导入历史立项</Secondary>
      </div>
      <InitiationTable items={initiations} members={members} onChanged={reload} />
    </>}
    <details className="rounded-xl border border-white/10 bg-white/[0.02]">
      <summary className="cursor-pointer px-4 py-3 text-xs text-white/45">旧版版本数据（保留，共 {legacyVersions.length} 条）</summary>
      <div className="border-t border-white/10 px-4 py-3">
        {legacyVersions.length === 0 ? <span className="text-xs text-white/30">暂无旧版数据</span> : legacyVersions.map((v) =>
          <div key={v.id} className="flex justify-between border-b border-white/5 py-2 text-xs last:border-0"><span className="text-white/70">{v.versionName}</span><span className="text-white/35">{v.lifecycle}</span></div>)}
      </div>
    </details>
    {dialog === 'initiation' && <InitiationWizard productId={productId} requirements={requirements} members={members} onClose={() => setDialog(null)} onChanged={reload} />}
    {(dialog === 'release' || dialog === 'temporary') && <ReleaseDialog productId={productId} approved={approved} requirements={requirements} members={members} temporary={dialog === 'temporary'} onClose={() => setDialog(null)} onChanged={reload} />}
    {importKind && <ImportDialog productId={productId} kind={importKind} onClose={() => setImportKind(null)} onChanged={reload} />}
  </div>;
}

function InitiationWizard({ productId, requirements, members, onClose, onChanged }: {
  productId: string; requirements: Requirement[]; members: ProductMember[]; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const [step, setStep] = useState(1);
  const [item, setItem] = useState<ProductInitiation | null>(null);
  const [projectType, setProjectType] = useState<'standard' | 'custom'>('standard');
  const [customerSource, setCustomerSource] = useState('');
  const [planName, setPlanName] = useState('');
  const [planUrl, setPlanUrl] = useState('');
  const [versionType, setVersionType] = useState<'major' | 'medium' | 'minor'>('minor');
  const [requirementIds, setRequirementIds] = useState<string[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [meeting, setMeeting] = useState(false);
  const [meetingAt, setMeetingAt] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const createBase = async () => {
    if (!planName.trim() || (projectType === 'custom' && !customerSource.trim())) return setMessage('请完整填写必填项');
    setBusy(true);
    const res = await createInitiation(productId, { projectType, customerSource, planName, planUrl, versionType, requirementIds });
    setBusy(false);
    if (!res.success) return setMessage(res.error?.message ?? '保存失败');
    setItem(res.data); setStep(2); setMessage('');
  };
  const runReview = async () => {
    if (!file || !item) return setMessage('请先上传方案文件');
    setBusy(true); setMessage('正在上传并提交 Agent 评审...');
    const uploaded = await uploadAttachment(file);
    if (!uploaded.success) { setBusy(false); return setMessage(uploaded.error?.message ?? '上传失败'); }
    const submitted = await createSubmission(planName, uploaded.data.attachmentId);
    if (!submitted.success) { setBusy(false); return setMessage(submitted.error?.message ?? '提交评审失败'); }
    for (let count = 0; count < 60; count++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const result = await getSubmission(submitted.data.submission.id);
      if (!result.success) continue;
      if (result.data.submission.status === 'Error') { setBusy(false); return setMessage(result.data.submission.errorMessage ?? '评审失败'); }
      if (result.data.submission.status === 'Done') {
        const synced = await syncInitiationReview(item.id, submitted.data.submission.id);
        setBusy(false);
        if (!synced.success) return setMessage(synced.error?.message ?? '同步评审结果失败');
        setItem(synced.data);
        if (synced.data.reviewPassed) { setStep(3); setMessage('评审通过，可以提交立项决策。'); }
        else setMessage(`评审未通过，得分 ${synced.data.reviewScore ?? 0}。请修改方案后重新立项。`);
        return;
      }
      setMessage(`Agent 评审中（${count + 1}/60）...`);
    }
    setBusy(false); setMessage('评审仍在后台进行，请稍后在列表中查看');
  };
  const submitDecision = async () => {
    if (!item) return;
    setBusy(true);
    const res = await decideInitiation(item.id, {
      reviewMeetingRequired: meeting,
      expectedMeetingAt: meeting && meetingAt ? new Date(meetingAt).toISOString() : undefined,
      primaryOwnerId: meeting ? undefined : ownerId,
    });
    setBusy(false);
    if (!res.success) return setMessage(res.error?.message ?? '提交失败');
    await onChanged(); onClose();
  };

  return <Modal title="发起立项" onClose={onClose} width="max-w-3xl">
    <Stepper step={step} />
    {step === 1 && <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Field label="项目类别"><Select value={projectType} onChange={(e) => setProjectType(e.target.value as typeof projectType)}><option value="standard">非定制</option><option value="custom">定制</option></Select></Field>
      {projectType === 'custom' && <Field label="客户来源 *"><Input value={customerSource} onChange={(e) => setCustomerSource(e.target.value)} /></Field>}
      <Field label="方案名称 *"><Input value={planName} onChange={(e) => setPlanName(e.target.value)} /></Field>
      <Field label="方案地址"><Input value={planUrl} onChange={(e) => setPlanUrl(e.target.value)} placeholder="https://" /></Field>
      <Field label="版本级别"><Select value={versionType} onChange={(e) => setVersionType(e.target.value as typeof versionType)}>{Object.entries(SCALE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
      <Field label="关联需求" full><Checks items={requirements.map((r) => ({ id: r.id, label: `${r.requirementNo} ${r.title}` }))} selected={requirementIds} onChange={setRequirementIds} /></Field>
    </div>}
    {step === 2 && <div className="space-y-4">
      <label className="flex min-h-40 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-cyan-400/35 bg-cyan-400/5 text-center">
        <Upload className="mb-3 text-cyan-300" size={28} /><span className="text-sm text-white/75">{file ? file.name : '拖动或点击上传方案文件'}</span>
        <span className="mt-1 text-xs text-white/35">PDF、Word、Markdown、Excel、PPT</span>
        <input type="file" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      {item?.reviewScore != null && <Score score={item.reviewScore} passed={item.reviewPassed === true} />}
    </div>}
    {step === 3 && <div className="space-y-4">
      <Field label="是否需要开评审会"><Select value={meeting ? 'yes' : 'no'} onChange={(e) => setMeeting(e.target.value === 'yes')}><option value="no">不需要</option><option value="yes">需要</option></Select></Field>
      {meeting ? <Field label="预计评审会时间 *"><Input type="datetime-local" value={meetingAt} onChange={(e) => setMeetingAt(e.target.value)} /></Field>
        : <Field label="产品主负责人 *"><Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}><option value="">请选择</option>{members.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}</Select></Field>}
      <Info>{meeting ? '提交后立即获取 T 立项号。' : '提交后流转给主负责人，负责人同意后生成 T 立项号。'}</Info>
    </div>}
    {message && <div className="mt-4 rounded-lg bg-white/5 px-3 py-2 text-xs text-white/60">{message}</div>}
    <div className="mt-6 flex justify-end gap-2"><Secondary onClick={onClose}>取消</Secondary>
      {step === 1 && <Primary onClick={createBase} disabled={busy}>{busy ? '保存中...' : '下一步'}</Primary>}
      {step === 2 && <Primary onClick={runReview} disabled={busy}>{busy && <Loader2 size={14} className="animate-spin" />}上传并打分</Primary>}
      {step === 3 && <Primary onClick={submitDecision} disabled={busy || (meeting ? !meetingAt : !ownerId)}>提交立项</Primary>}
    </div>
  </Modal>;
}

function ReleaseDialog({ productId, approved, requirements, members, temporary, onClose, onChanged }: {
  productId: string; approved: ProductInitiation[]; requirements: Requirement[]; members: ProductMember[];
  temporary: boolean; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const [initiationId, setInitiationId] = useState('');
  const [planName, setPlanName] = useState('');
  const [extraIds, setExtraIds] = useState<string[]>([]);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [releaseAt, setReleaseAt] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const selected = approved.find((item) => item.id === initiationId);
  const reqMap = useMemo(() => new Map(requirements.map((r) => [r.id, r.title])), [requirements]);
  const save = async () => {
    setBusy(true);
    const res = await createRelease(productId, {
      initiationId: temporary ? undefined : initiationId, isTemporaryOptimization: temporary,
      planName, additionalRequirementIds: extraIds, teamMemberIds: teamIds,
      plannedReleaseAt: new Date(releaseAt).toISOString(),
    });
    setBusy(false);
    if (!res.success) return setMessage(res.error?.message ?? '申领失败');
    await onChanged(); onClose();
  };
  const disabled = busy || !releaseAt || teamIds.length === 0 || (temporary ? !planName.trim() : !initiationId);
  return <Modal title={temporary ? '临时优化需求上线' : '申领上线号'} onClose={onClose} width="max-w-2xl">
    <div className="space-y-4">
      {temporary ? <Field label="优化需求名称 *"><Input value={planName} onChange={(e) => setPlanName(e.target.value)} /></Field> : <>
        <Field label="立项号 *"><Select value={initiationId} onChange={(e) => setInitiationId(e.target.value)}><option value="">请选择</option>{approved.map((i) => <option key={i.id} value={i.id}>{i.tCode} · {i.planName}</option>)}</Select></Field>
        {selected && <Info><b>方案：</b>{selected.planName}<br /><b>级别：</b>{SCALE_LABEL[selected.versionType]}<br /><b>需求来源：</b>{selected.requirementIds.map((id) => reqMap.get(id) ?? id).join('、') || '无'}</Info>}
      </>}
      <Field label="允许新增需求"><Checks items={requirements.map((r) => ({ id: r.id, label: `${r.requirementNo} ${r.title}` }))} selected={extraIds} onChange={setExtraIds} /></Field>
      <Field label="项目组成员 *"><Checks items={members.map((m) => ({ id: m.userId, label: m.displayName }))} selected={teamIds} onChange={setTeamIds} /></Field>
      <Field label="上线时间 *"><Input type="datetime-local" value={releaseAt} onChange={(e) => setReleaseAt(e.target.value)} /></Field>
      <Info>确认后自动审批并生成 V 上线号，随后必须补充上线公告地址才能完成上线。</Info>
    </div>
    {message && <div className="mt-4 text-xs text-red-300">{message}</div>}
    <div className="mt-6 flex justify-end gap-2"><Secondary onClick={onClose}>取消</Secondary><Primary onClick={save} disabled={disabled}>{busy ? '处理中...' : '确认并获取上线号'}</Primary></div>
  </Modal>;
}

function InitiationTable({ items, members, onChanged }: { items: ProductInitiation[]; members: ProductMember[]; onChanged: () => Promise<void> }) {
  const names = useMemo(() => new Map(members.map((m) => [m.userId, m.displayName])), [members]);
  return <Table headers={['立项号', '方案名称', '类别', '版本级别', '评审', '状态', '操作']}>
    {items.map((item) => <tr key={item.id} className="border-t border-white/5">
      <Td mono>{item.tCode ?? '-'}</Td><Td>{item.planName}</Td><Td>{item.projectType === 'custom' ? `定制 · ${item.customerSource ?? ''}` : '非定制'}</Td>
      <Td>{SCALE_LABEL[item.versionType]}</Td><Td>{item.reviewScore == null ? '-' : `${item.reviewScore} 分`}</Td><Td><Status value={item.status} /></Td>
      <Td>{item.status === 'owner_pending' ? <button onClick={async () => { await approveInitiation(item.id); await onChanged(); }} className="text-cyan-300">负责人同意{item.primaryOwnerId ? `（${names.get(item.primaryOwnerId) ?? item.primaryOwnerId}）` : ''}</button> : '-'}</Td>
    </tr>)}{items.length === 0 && <Empty cols={7}>暂无立项记录</Empty>}
  </Table>;
}

function ReleaseTable({ items, requirements, members, onChanged }: { items: ProductRelease[]; requirements: Requirement[]; members: ProductMember[]; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const names = useMemo(() => new Map(members.map((m) => [m.userId, m.displayName])), [members]);
  const reqNames = useMemo(() => new Map(requirements.map((r) => [r.id, r.title])), [requirements]);
  return <Table headers={['上线号', '立项号', '方案', '需求来源', '项目组成员', '上线时间', '公告', '状态']}>
    {items.map((item) => <tr key={item.id} className="border-t border-white/5 align-top">
      <Td mono>{item.vCode}</Td><Td mono>{item.tCode ?? '临时优化'}</Td><Td>{item.planName}</Td>
      <Td>{item.requirementIds.map((id) => reqNames.get(id) ?? id).join('、') || '-'}</Td><Td>{item.teamMemberIds.map((id) => names.get(id) ?? id).join('、')}</Td>
      <Td>{item.plannedReleaseAt ? new Date(item.plannedReleaseAt).toLocaleString() : '-'}</Td>
      <Td>{item.status === 'announcement_pending' ? editing === item.id ? <div className="flex min-w-64 gap-1"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="粘贴公告地址" /><button onClick={async () => { const r = await completeRelease(item.id, url); if (r.success) { setEditing(null); setUrl(''); await onChanged(); } }} className="rounded bg-cyan-400 px-2 text-slate-950">完成</button></div>
        : <div className="flex gap-2"><a href="https://sso.baklib.com/" target="_blank" rel="noreferrer" className="text-cyan-300">去发布公告</a><button onClick={() => setEditing(item.id)} className="text-white/50">填写地址</button></div>
        : item.announcementUrl ? <a className="text-cyan-300" href={item.announcementUrl} target="_blank" rel="noreferrer">查看公告</a> : '-'}</Td>
      <Td><Status value={item.status} /></Td>
    </tr>)}{items.length === 0 && <Empty cols={8}>暂无上线记录</Empty>}
  </Table>;
}

function ImportDialog({ productId, kind, onClose, onChanged }: { productId: string; kind: ImportKind; onClose: () => void; onChanged: () => Promise<void> }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const read = async (file: File) => {
    if (file.name.toLowerCase().endsWith('.xls')) return setMessage('旧版 .xls 请先在 Excel 中另存为 .xlsx 后导入。');
    try {
      const raw = file.name.toLowerCase().endsWith('.csv') ? await readCsv(file) : await readXlsx(file);
      setRows(raw.map((row) => normalizeRow(row, kind))); setMessage(`已读取 ${raw.length} 行，请确认后导入。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : '文件解析失败'); }
  };
  const commit = async () => {
    setBusy(true); const res = await importVersionWorkflow(productId, { kind, rows }); setBusy(false);
    if (!res.success) return setMessage(res.error?.message ?? '导入失败');
    setMessage(`成功 ${res.data.created} 条，失败 ${res.data.errors.length} 条。`); await onChanged();
    if (res.data.errors.length === 0) onClose();
  };
  return <Modal title={`导入历史${kind === 'initiation' ? '立项' : '上线'}数据`} onClose={onClose} width="max-w-4xl">
    <div onClick={() => inputRef.current?.click()} className="cursor-pointer rounded-xl border border-dashed border-white/20 p-8 text-center">
      <FileSpreadsheet className="mx-auto mb-2 text-emerald-300" /><div className="text-sm text-white/70">选择 Excel 或 CSV 文件</div><div className="mt-1 text-xs text-white/35">支持 .xlsx、.csv；先预览再写入</div>
      <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void read(f); }} />
    </div>
    {rows.length > 0 && <div className="mt-4 max-h-72 overflow-auto rounded-lg border border-white/10"><table className="w-full text-left text-xs"><thead className="sticky top-0 bg-[#1a1c22] text-white/45"><tr>{Object.keys(rows[0]).filter((k) => k !== 'legacyData').map((k) => <th key={k} className="px-3 py-2">{k}</th>)}</tr></thead><tbody>{rows.slice(0, 20).map((row, index) => <tr key={index} className="border-t border-white/5">{Object.entries(row).filter(([k]) => k !== 'legacyData').map(([k, value]) => <td key={k} className="max-w-52 truncate px-3 py-2 text-white/60">{String(value ?? '')}</td>)}</tr>)}</tbody></table></div>}
    {message && <div className="mt-3 text-xs text-white/55">{message}</div>}
    <div className="mt-6 flex justify-end gap-2"><Secondary onClick={onClose}>取消</Secondary><Primary onClick={commit} disabled={busy || rows.length === 0}>{busy ? '导入中...' : `确认导入 ${rows.length} 条`}</Primary></div>
  </Modal>;
}

async function readCsv(file: File) {
  const lines = (await file.text()).replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((v) => v.trim());
  return lines.slice(1).map((line) => Object.fromEntries(line.split(',').map((value, index) => [headers[index], value.trim()])));
}

async function readXlsx(file: File) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const parser = new DOMParser();
  const workbook = await zip.file('xl/workbook.xml')?.async('text');
  const rels = await zip.file('xl/_rels/workbook.xml.rels')?.async('text');
  if (!workbook || !rels) throw new Error('无法读取 Excel 工作簿');
  const sharedXml = await zip.file('xl/sharedStrings.xml')?.async('text');
  const shared = sharedXml ? Array.from(parser.parseFromString(sharedXml, 'text/xml').getElementsByTagName('si')).map((n) => n.textContent ?? '') : [];
  const relationMap = new Map(Array.from(parser.parseFromString(rels, 'text/xml').getElementsByTagName('Relationship')).map((n) => [n.getAttribute('Id'), n.getAttribute('Target')]));
  const sheet = parser.parseFromString(workbook, 'text/xml').getElementsByTagName('sheet')[0];
  const rid = sheet?.getAttribute('r:id') ?? sheet?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
  const target = rid ? relationMap.get(rid) : null;
  if (!target) throw new Error('Excel 中没有可读取的工作表');
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.?\//, '')}`;
  const sheetXml = await zip.file(path)?.async('text');
  if (!sheetXml) throw new Error('无法读取第一张工作表');
  const doc = parser.parseFromString(sheetXml, 'text/xml');
  const matrix = Array.from(doc.getElementsByTagName('row')).map((row) => {
    const values: string[] = [];
    Array.from(row.getElementsByTagName('c')).forEach((cell) => {
      const letters = (cell.getAttribute('r') ?? 'A1').replace(/\d/g, '');
      let index = 0; for (const char of letters) index = index * 26 + char.charCodeAt(0) - 64;
      const raw = cell.getElementsByTagName('v')[0]?.textContent ?? cell.getElementsByTagName('t')[0]?.textContent ?? '';
      values[index - 1] = cell.getAttribute('t') === 's' ? shared[Number(raw)] ?? '' : raw;
    });
    return values;
  }).filter((row) => row.some(Boolean));
  const headers = matrix[0] ?? [];
  return matrix.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));
}

function normalizeRow(raw: Record<string, string>, kind: ImportKind): Record<string, unknown> {
  const get = (...keys: string[]) => Object.entries(raw).find(([key]) => keys.some((candidate) => key.trim().toLowerCase() === candidate.toLowerCase()))?.[1]?.trim() ?? '';
  return {
    code: get(kind === 'initiation' ? '立项号' : '上线号', kind === 'initiation' ? 'T号' : 'V号', '版本号', 'code'),
    tCode: get('立项号', 'T号', 'tCode'), planName: get('方案名称', '项目名称', '版本名称', '需求名称', 'planName'),
    versionType: get('版本级别', '版本类型', 'versionType') || 'minor',
    projectType: get('项目类别', '是否定制', 'projectType').includes('定制') ? 'custom' : 'standard',
    customerSource: get('客户来源', '客户', 'customerSource'), planUrl: get('方案地址', '方案链接', 'planUrl'),
    announcementUrl: get('上线公告地址', '公告地址', 'announcementUrl'),
    date: get('上线时间', '立项时间', '日期', 'date') || undefined, legacyData: raw,
  };
}

function Stepper({ step }: { step: number }) { return <div className="mb-6 flex">{['基础信息', 'Agent 评审', '立项决策'].map((label, i) => <div key={label} className="flex flex-1 items-center last:flex-none"><div className={`flex items-center gap-2 text-xs ${step >= i + 1 ? 'text-cyan-300' : 'text-white/30'}`}><span className={`flex h-7 w-7 items-center justify-center rounded-full border ${step > i + 1 ? 'border-cyan-400 bg-cyan-400 text-slate-950' : step === i + 1 ? 'border-cyan-400' : 'border-white/15'}`}>{step > i + 1 ? <CheckCircle2 size={15} /> : i + 1}</span>{label}</div>{i < 2 && <div className={`mx-3 h-px flex-1 ${step > i + 1 ? 'bg-cyan-400' : 'bg-white/10'}`} />}</div>)}</div>; }
function Modal({ title, onClose, width, children }: { title: string; onClose: () => void; width: string; children: React.ReactNode }) { return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"><div className={`max-h-[90vh] w-full ${width} overflow-auto rounded-2xl border border-white/10 bg-[#15171c]`}><div className="sticky top-0 z-10 flex justify-between border-b border-white/10 bg-[#15171c] px-6 py-4"><h3 className="text-base font-semibold text-white/90">{title}</h3><button onClick={onClose} className="text-white/40"><X size={18} /></button></div><div className="p-6">{children}</div></div></div>; }
function Field({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) { return <label className={full ? 'md:col-span-2' : ''}><span className="mb-1.5 block text-xs text-white/50">{label}</span>{children}</label>; }
function Input(props: React.InputHTMLAttributes<HTMLInputElement>) { return <input {...props} className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none placeholder:text-white/25 focus:border-cyan-400/50" />; }
function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) { return <select {...props} className="w-full rounded-lg border border-white/10 bg-[#111318] px-3 py-2 text-sm text-white outline-none">{props.children}</select>; }
function Checks({ items, selected, onChange }: { items: { id: string; label: string }[]; selected: string[]; onChange: (ids: string[]) => void }) { return <div className="max-h-40 overflow-auto rounded-lg border border-white/10 bg-black/15 p-2">{items.length === 0 ? <div className="p-2 text-xs text-white/30">暂无可选数据</div> : items.map((item) => <label key={item.id} className="flex cursor-pointer gap-2 rounded px-2 py-1.5 text-xs text-white/65 hover:bg-white/5"><input type="checkbox" className="accent-cyan-400" checked={selected.includes(item.id)} onChange={() => onChange(selected.includes(item.id) ? selected.filter((id) => id !== item.id) : [...selected, item.id])} />{item.label}</label>)}</div>; }
function Primary(props: React.ButtonHTMLAttributes<HTMLButtonElement>) { return <button {...props} className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-400 px-3 py-2 text-xs font-medium text-slate-950 disabled:opacity-40">{props.children}</button>; }
function Secondary(props: React.ButtonHTMLAttributes<HTMLButtonElement>) { return <button {...props} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/65">{props.children}</button>; }
function Tab({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) { return <button onClick={onClick} className={`border-b-2 px-4 py-3 text-sm ${active ? 'border-cyan-400 text-cyan-200' : 'border-transparent text-white/40'}`}>{children}</button>; }
function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) { return <div className="overflow-x-auto rounded-xl border border-white/10"><table className="w-full min-w-[900px] text-left text-xs"><thead className="bg-white/[0.035] text-white/40"><tr>{headers.map((h) => <th key={h} className="px-3 py-3 font-medium">{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>; }
function Td({ children, mono }: { children: React.ReactNode; mono?: boolean }) { return <td className={`max-w-64 px-3 py-3 text-white/65 ${mono ? 'font-mono text-cyan-200' : ''}`}>{children}</td>; }
function Empty({ cols, children }: { cols: number; children: React.ReactNode }) { return <tr><td colSpan={cols} className="px-3 py-12 text-center text-white/30">{children}</td></tr>; }
function Status({ value }: { value: string }) { const good = value === 'approved' || value === 'released'; return <span className={`rounded-full border px-2 py-0.5 ${good ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300' : 'border-amber-400/20 bg-amber-400/10 text-amber-200'}`}>{STATUS_LABEL[value] ?? value}</span>; }
function Info({ children }: { children: React.ReactNode }) { return <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 text-xs leading-5 text-white/55">{children}</div>; }
function Score({ score, passed }: { score: number; passed: boolean }) { return <div className={`rounded-xl border p-5 text-center ${passed ? 'border-emerald-400/25 bg-emerald-400/10' : 'border-red-400/25 bg-red-400/10'}`}><div className={`text-4xl font-semibold ${passed ? 'text-emerald-300' : 'text-red-300'}`}>{score}</div><div className="mt-1 text-sm text-white/65">{passed ? '评审通过' : '评审未通过'}</div></div>; }
