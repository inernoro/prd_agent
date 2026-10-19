import { useEffect, useMemo, useState } from 'react';
import {
  createProductVersionSnapshot, getLegacyVersionCopyTemplate,
  getProductVersionSnapshot, listLegacyVersionRegistrations,
  listProductVersionSnapshots, type ProductVersionSnapshotSummary,
} from '@/services/real/productAgent';
import type { VersionRegistration } from '@/services/real/versionRegistration';

const FIELD_CLASS = 'rounded-lg border border-token-subtle bg-token-nested px-3 py-2 text-xs text-token-primary outline-none focus:border-cyan-400/50';

export function LegacyVersionArchive({ kind, isAdmin, mode }: {
  kind: 'internal' | 'formal';
  isAdmin: boolean;
  mode: 'legacy' | 'snapshots';
}) {
  if (mode === 'snapshots') return <SnapshotArchive isAdmin={isAdmin} kind={kind} />;
  return <LegacyRecordList kind={kind} />;
}

function LegacyRecordList({ kind }: { kind: 'internal' | 'formal' }) {
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [canViewAll, setCanViewAll] = useState(false);
  const [records, setRecords] = useState<VersionRegistration[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [person, setPerson] = useState('');
  const [system, setSystem] = useState('');
  const [application, setApplication] = useState('');
  const [openId, setOpenId] = useState('');
  const [copyHint, setCopyHint] = useState('');

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void listLegacyVersionRegistrations(kind, scope).then((response) => {
      if (cancelled) return;
      if (response.success) {
        setRecords(response.data.items);
        setCanViewAll(response.data.canViewAll);
        setError('');
      } else setError(response.error?.message ?? '旧登记记录加载失败');
      setBusy(false);
    });
    return () => { cancelled = true; };
  }, [kind, scope]);

  const systems = useMemo(() => Array.from(new Set(records.map((record) => record.systemName).filter(Boolean))).sort() as string[], [records]);
  const applications = useMemo(() => Array.from(new Set(records.filter((record) => !system || record.systemName === system).map((record) => record.applicationName).filter(Boolean))).sort() as string[], [records, system]);
  const people = useMemo(() => Array.from(new Set(records.map((record) => record.ownerName || record.createdByName || record.createdBy).filter(Boolean))).sort() as string[], [records]);
  const filtered = useMemo(() => records.filter((record) => {
    const owner = record.ownerName || record.createdByName || record.createdBy;
    return (!person || owner === person)
      && (!system || record.systemName === system)
      && (!application || record.applicationName === application)
      && (!query || [record.code, record.tCode, record.planName, record.planUrl].some((value) => value?.toLowerCase().includes(query.toLowerCase())));
  }), [application, person, query, records, system]);

  const copy = async (record: VersionRegistration, full: boolean) => {
    try {
      let value = record.code;
      if (full) {
        const response = await getLegacyVersionCopyTemplate(record.id);
        if (!response.success) {
          setCopyHint(response.error?.message ?? '通知生成失败');
          return;
        }
        value = response.data.text;
      }
      await navigator.clipboard.writeText(value);
      setCopyHint(full ? '完整通知已复制' : '编号已复制');
    } catch {
      setCopyHint('浏览器未允许复制，请选中内容手动复制');
    }
  };

  return (
    <section className="space-y-3">
      <div className="rounded-lg border border-token-subtle bg-token-nested p-3 text-xs text-token-muted">旧登记簿只读保留；新申领统一走产品管理工作流。系统与应用仅用于检索。</div>
      <div className="flex flex-wrap gap-2">
        {canViewAll && <select className={FIELD_CLASS} value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="mine">我的记录</option><option value="all">全部人员</option></select>}
        <select className={FIELD_CLASS} value={person} onChange={(event) => setPerson(event.target.value)}><option value="">全部负责人</option>{people.map((value) => <option key={value}>{value}</option>)}</select>
        <select className={FIELD_CLASS} value={system} onChange={(event) => { setSystem(event.target.value); setApplication(''); }}><option value="">全部系统</option>{systems.map((value) => <option key={value}>{value}</option>)}</select>
        <select className={FIELD_CLASS} value={application} onChange={(event) => setApplication(event.target.value)}><option value="">全部应用</option>{applications.map((value) => <option key={value}>{value}</option>)}</select>
        <input className={FIELD_CLASS} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索编号或方案" aria-label="搜索旧登记记录" />
      </div>
      {busy ? <p className="py-8 text-sm text-token-muted">正在加载旧登记记录…</p> : error ? <p className="py-8 text-sm text-[color:var(--accent-fg-danger)]">{error}</p> : filtered.length === 0 ? <p className="py-8 text-sm text-token-muted">没有符合条件的旧登记记录</p> : (
        <div className="max-h-[580px] space-y-2 overflow-y-auto">
          {filtered.map((record) => (
            <article key={record.id} className="rounded-lg border border-token-subtle bg-token-nested p-3">
              <button type="button" onClick={() => { setOpenId(openId === record.id ? '' : record.id); setCopyHint(''); }} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 text-left">
                <span className="font-mono text-sm text-[color:var(--accent-fg-blue)]">{record.code}</span>
                <span className="text-sm text-token-primary">{record.planName || '未填写方案名称'}</span>
                <span className="text-xs text-token-muted">{record.applicationName || '未关联应用'} · {record.ownerName || record.createdByName || '-'}</span>
              </button>
              {openId === record.id && <div className="mt-3 space-y-2 border-t border-token-subtle pt-3 text-xs text-token-secondary">
                <p>系统：{record.systemName || '-'}　应用：{record.applicationName || '-'}　来源：{record.sourceType === 'history_import' ? '历史导入' : '旧登记流程'}</p>
                <p>T 来源：{record.tCode || '-'}　需求来源：{record.demandSource || '-'}　部门：{record.departmentName || '-'}</p>
                <p>方案地址：{record.planUrl || '-'}　计划时间：{record.plannedReleaseAt || record.plannedProjectAt || '-'}</p>
                {record.kind === 'formal' && <p>预计培训时间：{record.plannedTrainingAt ? new Date(record.plannedTrainingAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '历史记录未填写'}</p>}
                {record.requirementDescription && <p className="whitespace-pre-wrap">项目需求描述：{record.requirementDescription}</p>}
                {record.remark && <p className="whitespace-pre-wrap">备注：{record.remark}</p>}
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => void copy(record, false)} className={FIELD_CLASS}>复制编号</button>
                  <button type="button" onClick={() => void copy(record, true)} className={FIELD_CLASS}>复制完整通知</button>
                  {copyHint && <span role="status" className="text-token-muted">{copyHint}</span>}
                </div>
              </div>}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function SnapshotArchive({ isAdmin, kind }: { isAdmin: boolean; kind: 'internal' | 'formal' }) {
  const [items, setItems] = useState<ProductVersionSnapshotSummary[]>([]);
  const [scope, setScope] = useState<'mine' | 'all'>(isAdmin ? 'all' : 'mine');
  const [name, setName] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getProductVersionSnapshot>>['data'] | null>(null);
  const [message, setMessage] = useState('');

  const reload = async () => {
    const result = await listProductVersionSnapshots(scope);
    if (result.success) setItems(result.data.items);
    else setMessage(result.error?.message ?? '存档加载失败');
  };
  useEffect(() => { void reload(); }, [scope]);

  const create = async () => {
    const result = await createProductVersionSnapshot(name.trim() || undefined);
    if (!result.success) return setMessage(result.error?.message ?? '存档创建失败');
    setMessage(`已保存当前版本工作流存档，共 ${result.data.recordCount} 条。`);
    setName('');
    await reload();
  };
  const open = async (id: string) => {
    setSelectedId(id);
    const result = await getProductVersionSnapshot(id);
    if (result.success) setDetail(result.data);
    else setMessage(result.error?.message ?? '存档加载失败');
  };

  const records = detail?.registry
    ? detail.snapshot.records?.filter((record) => record.kind === kind).map((record) => ({ id: record.id, code: record.code, planName: record.planName ?? '' })) ?? []
    : kind === 'internal'
      ? detail?.snapshot.initiations?.map((record) => ({ id: record.id, code: record.tCode ?? '', planName: record.planName })) ?? []
      : detail?.snapshot.releases?.map((record) => ({ id: record.id, code: record.vCode, planName: record.planName })) ?? [];

  return <section className="space-y-3">
    <p className="rounded-lg border border-token-subtle bg-token-nested p-3 text-xs text-token-muted">导入时自动留存不可变快照；也可保存当前产品版本工作流。旧登记簿的历史存档一并保留。</p>
    {isAdmin && <div className="flex flex-wrap gap-2">
      <input className={FIELD_CLASS} value={name} onChange={(event) => setName(event.target.value)} placeholder="存档名称（选填）" />
      <button type="button" onClick={() => void create()} className={FIELD_CLASS}>保存当前存档</button>
      <select className={FIELD_CLASS} value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="all">全部存档</option><option value="mine">我的存档</option></select>
    </div>}
    {message && <p role="status" className="text-xs text-token-secondary">{message}</p>}
    <div className="grid gap-3 lg:grid-cols-[minmax(250px,1fr)_minmax(0,2fr)]">
      <div className="max-h-[500px] space-y-2 overflow-y-auto">
        {items.map((item) => <button key={`${item.registry}-${item.id}`} type="button" onClick={() => void open(item.id)} className={`w-full rounded-lg border p-3 text-left text-xs ${selectedId === item.id ? 'border-cyan-400/50 bg-cyan-400/5' : 'border-token-subtle bg-token-nested'}`}>
          <span className="block text-sm text-token-primary">{item.name}</span>
          <span className="mt-1 block text-token-muted">{item.registry ? '旧登记' : '产品工作流'} · {item.recordCount} 条 · {new Date(item.createdAt).toLocaleString('zh-CN')}</span>
          {item.sourceFileName && <span className="mt-1 block text-token-muted">来源文件：{item.sourceFileName}</span>}
        </button>)}
        {items.length === 0 && <p className="py-6 text-xs text-token-muted">暂无存档</p>}
      </div>
      <div className="max-h-[500px] overflow-y-auto rounded-lg border border-token-subtle bg-token-nested p-3 text-xs text-token-secondary">
        {detail ? <>
          <h3 className="text-sm font-medium text-token-primary">{detail.snapshot.name}</h3>
          <p className="mt-2 text-token-muted">{records.length} 条记录；存档只读，不会修改现有编号或记录。</p>
          <div className="mt-3 space-y-1">{records.map((record) => <p key={record.id} className="border-b border-token-subtle py-1"><span className="mr-3 font-mono text-[color:var(--accent-fg-blue)]">{record.code || '-'}</span>{record.planName || '未填写方案名称'}</p>)}</div>
          {(detail.snapshot.errors?.length ?? 0) > 0 && <div className="mt-3"><h4 className="font-medium">导入未写入的行</h4>{detail.snapshot.errors?.map((error, index) => <p key={`${error.row}-${index}`}>第 {error.row} 行：{error.message}</p>)}</div>}
        </> : <p className="py-6 text-center text-token-muted">选择左侧存档查看内容</p>}
      </div>
    </div>
  </section>;
}
