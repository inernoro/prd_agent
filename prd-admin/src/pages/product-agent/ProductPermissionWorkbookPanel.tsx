import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Upload, Save, RefreshCw } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { useAuthStore } from '@/stores/authStore';
import { getProductPermissionMe, getProductPermissions, importProductPermissions, previewProductPermissions, type ProductPermissionSnapshot, type ProductPermissionWorkbook, type ProductPermissionPreview } from '@/services/real/productPermissions';
import { downloadPermissionWorkbook, readPermissionWorkbook, snapshotWorkbook } from './productPermissionWorkbook';
import type { ProductPermissionTab } from './ProductPermissionsPanel';

export function ProductPermissionWorkbookPanel({ tab }: { tab: ProductPermissionTab }) {
  const [snapshot, setSnapshot] = useState<ProductPermissionSnapshot>();
  const [draft, setDraft] = useState<ProductPermissionWorkbook>();
  const [preview, setPreview] = useState<ProductPermissionPreview>();
  const [menuKey, setMenuKey] = useState('requirements');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const reload = useCallback(async () => {
    setError('');
    const response = await getProductPermissions();
    if (!response.success) throw new Error(response.error.message);
    setSnapshot(response.data); setDraft(snapshotWorkbook(response.data)); setPreview(undefined);
  }, []);
  useEffect(() => { void reload().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '权限读取失败。')); }, [reload]);
  const validate = async (book: ProductPermissionWorkbook) => {
    setError(''); setMessage(''); setPreview(undefined); setBusy(true);
    try {
      const result = await previewProductPermissions(book);
      if (!result.success) throw new Error(result.error.message);
      setDraft(book); setPreview(result.data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '预检失败，未导入权限。'); }
    finally { setBusy(false); }
  };
  const chooseFile = async (file?: File) => {
    if (!file || !snapshot) return;
    setError(''); setPreview(undefined);
    try {
      if (!/\.xlsx$/i.test(file.name)) throw new Error('请上传.xlsx权限工作簿。');
      if (file.size > 4 * 1024 * 1024) throw new Error('权限文件不能超过4MB。');
      await validate(readPermissionWorkbook(await file.arrayBuffer(), snapshot));
    } catch (cause) { setError(cause instanceof Error ? cause.message : '文件读取失败。'); }
  };
  const commit = async () => {
    if (!draft || !preview || busy) return;
    setBusy(true); setError('');
    try {
      const result = await importProductPermissions(draft);
      if (!result.success) throw new Error(result.error.message);
      await reload();
      const me = await getProductPermissionMe();
      if (me.success) useAuthStore.getState().setPermissions(me.data.permissions);
      setMessage('产品权限已整本覆盖，其他应用及MAP角色未修改。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '导入失败，请重新预检。'); setPreview(undefined); }
    finally { setBusy(false); }
  };
  const refresh = async () => {
    setBusy(true); setPreview(undefined); setMessage('');
    try { await reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '最新配置读取失败，请重试。'); }
    finally { setBusy(false); }
  };
  if (!snapshot || !draft) return error ? <div role="alert" className="text-sm text-token-secondary">{error}<Button onClick={() => void reload().catch(() => setError('读取失败，请稍后重试。'))}>重试</Button></div> : <MapSectionLoader text="正在读取产品权限…" />;
  const menu = snapshot.menus.find((item) => item.key === menuKey) ?? snapshot.menus[0];
  const sheet = draft.sheets.find((item) => item.menu === menu.key)!;
  const label = (key: string) => snapshot.menus.find((m) => 'product-agent.menu.' + m.key === key)?.label ?? snapshot.functions[key] ?? key;
  const edit = (index: number, key: string, value: boolean) => {
    setPreview(undefined); setMessage('');
    setDraft({ ...draft, sheets: draft.sheets.map((item) => item.menu !== menu.key ? item : { ...item, rows: item.rows.map((row, i) => i !== index ? row : key === 'visible'
      ? { ...row, visible: value, functions: value ? row.functions : Object.fromEntries(Object.keys(row.functions).map((f) => [f, false])) }
      : { ...row, functions: { ...row.functions, [key]: value } }) }) });
  };
  return <div className="min-w-0 space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="max-w-2xl text-xs leading-6 text-token-secondary">每个菜单一个分表，整本覆盖产品管理权限。1为允许，0为禁止。MAP管理员始终拥有全部权限；其他人员均可修改。独立评审智能体不受影响。</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} title="读取服务端最新配置，放弃当前未保存的修改" onClick={() => void refresh()}><RefreshCw size={14} />读取最新配置</Button>
        <Button size="sm" disabled={busy} onClick={() => downloadPermissionWorkbook(draft, snapshot)}><Download size={14} />导出权限表</Button>
        <Button size="sm" disabled={busy} onClick={() => input.current?.click()}><Upload size={14} />导入权限表</Button>
        <input ref={input} type="file" accept=".xlsx" aria-label="选择产品权限工作簿" className="hidden" onChange={(event) => { void chooseFile(event.target.files?.[0]); event.target.value = ''; }} />
      </div>
    </div>
    {error && <p role="alert" className="rounded-lg border border-token-subtle p-3 text-sm text-token-secondary">{error}</p>}
    {message && <p role="status" className="text-sm text-token-secondary">{message}</p>}
    {preview && <section aria-label="覆盖导入预览" className="space-y-3 rounded-lg border border-token-subtle bg-token-nested p-4">
      <h3 className="text-sm font-semibold text-token-primary">覆盖前请确认：工作簿 {preview.people} 人，变更 {preview.changes.length} 人，未列普通人员 {preview.omittedCount} 人</h3>
      <p className="text-sm text-token-secondary">{preview.notice}</p>
      <div className="max-h-60 overflow-auto text-xs">{preview.changes.map((change) => <div key={change.userId} className="border-b border-token-subtle py-2"><p className="font-medium">{change.displayName}（{change.username}）{change.omitted ? '：不在表内，关闭产品权限' : ''}</p><p className="mt-1 text-token-muted">原：{change.before.map(label).join('、') || '无'}；新：{change.after.map(label).join('、') || '无'}</p></div>)}</div>
      <div className="flex gap-2"><Button variant="primary" size="sm" disabled={busy} onClick={() => void commit()}>{busy ? <MapSpinner size={14} /> : <Save size={14} />}确认整本覆盖</Button><Button size="sm" disabled={busy} onClick={() => setPreview(undefined)}>取消</Button></div>
    </section>}
    {tab === 'role' ? <div className="space-y-3">
      <p className="rounded-lg border border-token-subtle p-4 text-sm leading-7 text-token-secondary">MAP管理员始终拥有全部产品菜单。覆盖导入后，每人的产品权限以权限表为准，不修改MAP系统角色；普通人员可在菜单权限、功能权限页调整。</p>
      <div className="overflow-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-3">人员</th><th className="p-3">MAP系统角色</th><th className="p-3">产品菜单</th></tr></thead><tbody>{snapshot.users.map((person) => <tr key={person.userId} className="border-t border-token-subtle"><td className="p-3">{person.displayName}（{person.username}）</td><td className="p-3">{person.isMapAdmin ? 'MAP管理员' : person.systemRoleKey ?? 'none'}</td><td className="p-3">{person.isMapAdmin ? '全部菜单' : snapshot.menus.filter((m) => draft.sheets.find((s) => s.menu === m.key)?.rows.some((r) => r.userId === person.userId && r.visible)).map((m) => m.label).join('、') || '无'}</td></tr>)}</tbody></table></div>
    </div> : <>
      <div className="flex flex-wrap gap-3">
        <select aria-label="选择权限菜单" value={menu.key} disabled={busy} onChange={(e) => setMenuKey(e.target.value)} className="rounded-md border border-token-subtle bg-token-nested px-3 py-2 text-sm">{snapshot.menus.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select>
        <input aria-label="搜索权限人员" placeholder="搜索姓名或账号" value={query} onChange={(e) => setQuery(e.target.value)} className="min-w-40 rounded-md border border-token-subtle bg-token-nested px-3 py-2 text-sm" />
        <Button size="sm" disabled={busy} onClick={() => void validate(draft)}>{busy ? <MapSpinner size={14} /> : <Save size={14} />}预览并保存修改</Button>
      </div>
      <div className="overflow-auto rounded-lg border border-token-subtle"><table className="w-full text-left text-sm">
        <thead className="bg-token-nested text-token-secondary"><tr><th className="p-3">人员</th><th className="p-3">菜单可见</th>{tab === 'function' && menu.functions.map((key) => <th key={key} className="p-3">{snapshot.functions[key]}</th>)}</tr></thead>
        <tbody>{sheet.rows.map((row, index) => {
          if (! (row.displayName + row.username).includes(query.trim())) return null;
          const admin = snapshot.users.some((person) => person.userId === row.userId && person.isMapAdmin);
          return <tr key={row.userId || row.username || row.displayName} className="border-t border-token-subtle"><td className="p-3">{row.displayName}<span className="ml-2 text-xs text-token-muted">{row.username}{admin ? ' · MAP管理员，全部权限' : ''}</span></td>
            <td className="p-3"><input type="checkbox" aria-label={row.displayName + '菜单可见'} checked={admin || row.visible} disabled={admin || busy} onChange={(e) => edit(index, 'visible', e.target.checked)} /></td>
            {tab === 'function' && menu.functions.map((key) => <td key={key} className="p-3"><input type="checkbox" aria-label={row.displayName + snapshot.functions[key]} checked={admin || row.functions[key]} disabled={admin || busy || !row.visible} onChange={(e) => edit(index, key, e.target.checked)} /></td>)}</tr>;
        })}</tbody></table></div>
      {tab === 'function' && !menu.functions.length && <p className="text-xs text-token-muted">此菜单没有额外功能授权项，菜单开关决定是否可进入，业务数据范围仍按既有规则控制。</p>}
    </>}
  </div>;
}
