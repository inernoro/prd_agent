import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { Badge } from '@/components/design/Badge';
import { TabBar } from '@/components/design/TabBar';
import { Dialog } from '@/components/ui/Dialog';
import { ConfirmTip } from '@/components/ui/ConfirmTip';
import { Tooltip } from '@/components/ui/Tooltip';
import {
  getDataSummary,
  previewUsersPurge,
  purgeData,
  purgeUsers,
  getCollectionMappings,
  getCollectionData,
  validateCollection,
  deleteCollection,
  deleteDocument,
  deleteAppData,
} from '@/services';
import type { AdminUserPreviewItem, AdminUsersPurgePreviewResponse, DataSummaryResponse } from '@/services/contracts/data';
import type {
  CollectionMappingsResponse,
  CollectionMappingItem,
  CollectionDataResponse,
  CollectionValidationResponse,
} from '@/services/contracts/data-migration';
import { DataTransferDialog } from '@/pages/model-manage/DataTransferDialog';
import {
  AlertTriangle,
  Database,
  RefreshCw,
  Server,
  Trash2,
  Users,
  Zap,
  Eye,
  Wrench,
  ChevronLeft,
  ChevronRight,
  Search,
  Code,
  Table,
  MessageSquare,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

function safeIdempotencyKey() {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (c && 'randomUUID' in c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function fmtNum(n: number | null | undefined) {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? v.toLocaleString() : '0';
}

function fmtDate(s: string | null | undefined) {
  if (!s) return '-';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '-';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 统计卡片组件
function StatCard({
  icon,
  label,
  value,
  subValue,
  accent = 'default',
  loading,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  subValue?: string;
  accent?: 'default' | 'gold' | 'blue' | 'green' | 'purple';
  loading?: boolean;
}) {
  const accentColors = {
    default: { bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.06)', icon: 'rgba(255,255,255,0.5)', text: 'var(--text-primary)' },
    gold: { bg: 'rgba(214,178,106,0.06)', border: 'rgba(214,178,106,0.12)', icon: 'var(--accent-gold)', text: 'var(--accent-gold)' },
    blue: { bg: 'rgba(59,130,246,0.06)', border: 'rgba(59,130,246,0.12)', icon: 'rgba(59,130,246,0.9)', text: 'rgba(59,130,246,0.95)' },
    green: { bg: 'rgba(34,197,94,0.06)', border: 'rgba(34,197,94,0.12)', icon: 'rgba(34,197,94,0.9)', text: 'rgba(34,197,94,0.95)' },
    purple: { bg: 'rgba(168,85,247,0.06)', border: 'rgba(168,85,247,0.12)', icon: 'rgba(168,85,247,0.9)', text: 'rgba(168,85,247,0.95)' },
  };
  const colors = accentColors[accent];

  return (
    <div className="relative overflow-hidden rounded-[12px] p-3.5 transition-all duration-200" style={{ background: colors.bg, border: `1px solid ${colors.border}` }}>
      <div className="relative flex items-start gap-3">
        <div className="shrink-0 w-9 h-9 rounded-[10px] flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.05)' }}>
          <span style={{ color: colors.icon }}>{icon}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-wider truncate" style={{ color: 'var(--text-muted)' }}>{label}</div>
          <div className="mt-1 text-xl font-bold tabular-nums tracking-tight" style={{ color: colors.text, letterSpacing: '-0.02em' }}>
            {loading ? <span className="inline-block w-14 h-6 rounded-[8px] animate-pulse" style={{ background: 'rgba(255,255,255,0.05)' }} /> : value}
          </div>
          {subValue && <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>{subValue}</div>}
        </div>
      </div>
    </div>
  );
}

// 危险操作卡片组件
function DangerActionCard({ title, description, buttonText, onAction, loading, confirmTitle, confirmDescription }: {
  title: string; description: string; buttonText: string; onAction: () => void | Promise<void>; loading?: boolean; confirmTitle?: string; confirmDescription?: string;
}) {
  const needsConfirm = confirmTitle && confirmDescription;
  return (
    <div className="rounded-[12px] p-3 transition-all duration-200" style={{ background: 'rgba(239,68,68,0.04)', border: '1px solid rgba(239,68,68,0.12)' }}>
      <div className="flex items-start gap-2.5">
        <div className="shrink-0 w-7 h-7 rounded-[8px] flex items-center justify-center mt-0.5" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.15)' }}>
          <AlertTriangle size={14} style={{ color: 'rgba(239,68,68,0.8)' }} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</div>
          <div className="mt-0.5 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>{description}</div>
        </div>
        <div className="shrink-0 ml-2">
          {needsConfirm ? (
            <ConfirmTip title={confirmTitle} description={confirmDescription} confirmText={buttonText} onConfirm={async () => { await onAction(); }} disabled={loading} side="top" align="end">
              <Button variant="danger" size="xs" disabled={loading}><Trash2 size={12} />{buttonText}</Button>
            </ConfirmTip>
          ) : (
            <Tooltip content="该操作不可恢复" side="top" align="end">
              <span><Button variant="danger" size="xs" disabled={loading} onClick={() => void onAction()}><Trash2 size={12} />{buttonText}</Button></span>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}

// 数据查看模态窗
function CollectionDataViewerDialog({ open, onOpenChange, collectionName }: { open: boolean; onOpenChange: (open: boolean) => void; collectionName: string }) {
  const [data, setData] = useState<CollectionDataResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [viewMode, setViewMode] = useState<'table' | 'json'>('table');

  const loadData = useCallback(async () => {
    if (!collectionName) return;
    setLoading(true);
    try {
      const res = await getCollectionData(collectionName, page, 20);
      if (res.success && res.data) setData(res.data);
    } finally {
      setLoading(false);
    }
  }, [collectionName, page]);

  useEffect(() => { if (open) { setPage(1); void loadData(); } }, [open, collectionName]);
  useEffect(() => { if (open) void loadData(); }, [page]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`查看数据：${collectionName}`} description={`共 ${fmtNum(data?.totalCount ?? 0)} 条记录`} maxWidth={1200} content={
      <div className="flex flex-col gap-4 min-h-[400px] max-h-[70vh]">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button variant={viewMode === 'table' ? 'primary' : 'secondary'} size="xs" onClick={() => setViewMode('table')}><Table size={13} />表格</Button>
            <Button variant={viewMode === 'json' ? 'primary' : 'secondary'} size="xs" onClick={() => setViewMode('json')}><Code size={13} />JSON</Button>
          </div>
          <Button variant="secondary" size="xs" onClick={loadData} disabled={loading}><RefreshCw size={13} className={loading ? 'animate-spin' : ''} />刷新</Button>
        </div>
        <div className="flex-1 overflow-auto rounded-[12px]" style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.06)' }}>
          {loading ? (
            <div className="flex items-center justify-center h-full" style={{ color: 'var(--text-muted)' }}><RefreshCw size={20} className="animate-spin mr-2" />加载中...</div>
          ) : viewMode === 'table' ? (
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                    {data?.fields.map((field) => (
                      <th key={field} className="px-3 py-2 text-left font-semibold whitespace-nowrap" style={{ color: 'var(--text-secondary)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>{field}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data?.data.map((row, idx) => (
                    <tr key={idx} className="hover:bg-white/3 transition-colors">
                      {data.fields.map((field) => (
                        <td key={field} className="px-3 py-2 whitespace-nowrap max-w-[300px] truncate" style={{ color: 'var(--text-primary)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                          {typeof (row as Record<string, unknown>)[field] === 'object' ? JSON.stringify((row as Record<string, unknown>)[field]) : String((row as Record<string, unknown>)[field] ?? '-')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-4 space-y-3 overflow-auto">
              {data?.data.map((row, idx) => (
                <pre key={idx} className="p-3 rounded-[8px] text-xs overflow-x-auto" style={{ background: 'rgba(255,255,255,0.03)', color: 'var(--text-primary)' }}>{JSON.stringify(row, null, 2)}</pre>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>第 {page} / {data?.totalPages ?? 1} 页</div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="xs" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft size={14} />上一页</Button>
            <Button variant="secondary" size="xs" disabled={page >= (data?.totalPages ?? 1)} onClick={() => setPage((p) => p + 1)}>下一页<ChevronRight size={14} /></Button>
          </div>
        </div>
      </div>
    } />
  );
}

// 字段匹配验证模态窗
function CollectionValidationDialog({ open, onOpenChange, collectionName, onRefresh }: { open: boolean; onOpenChange: (open: boolean) => void; collectionName: string; onRefresh: () => void }) {
  const [data, setData] = useState<CollectionValidationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!collectionName) return;
    setLoading(true);
    try {
      const res = await validateCollection(collectionName, 500);
      if (res.success && res.data) setData(res.data);
    } finally {
      setLoading(false);
    }
  }, [collectionName]);

  useEffect(() => { if (open) void loadData(); }, [open, collectionName]);

  const handleDeleteDocument = async (docId: string) => {
    setDeleting(docId);
    try {
      const res = await deleteDocument(collectionName, docId, true);
      if (res.success) { await loadData(); onRefresh(); }
    } finally {
      setDeleting(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`字段匹配验证：${collectionName}`} description={data?.hasEntity ? `实体类：${data.entityName}` : '无对应实体类'} maxWidth={1200} content={
      <div className="flex flex-col gap-4 min-h-[400px] max-h-[70vh]">
        <div className="grid grid-cols-4 gap-3">
          <div className="rounded-[10px] p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>扫描文档</div>
            <div className="text-lg font-bold mt-1" style={{ color: 'var(--text-primary)' }}>{fmtNum(data?.scannedDocuments ?? 0)}</div>
          </div>
          <div className="rounded-[10px] p-3" style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.15)' }}>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>有效文档</div>
            <div className="text-lg font-bold mt-1" style={{ color: 'rgba(34,197,94,0.95)' }}>{fmtNum(data?.validDocuments ?? 0)}</div>
          </div>
          <div className="rounded-[10px] p-3" style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)' }}>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>问题文档</div>
            <div className="text-lg font-bold mt-1" style={{ color: 'rgba(239,68,68,0.95)' }}>{fmtNum(data?.invalidDocuments ?? 0)}</div>
          </div>
          <div className="rounded-[10px] p-3" style={{ background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)' }}>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>实体字段数</div>
            <div className="text-lg font-bold mt-1" style={{ color: 'rgba(59,130,246,0.95)' }}>{data?.entityFields.length ?? 0}</div>
          </div>
        </div>
        <div className="flex-1 overflow-auto rounded-[12px]" style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.06)' }}>
          {loading ? (
            <div className="flex items-center justify-center h-full" style={{ color: 'var(--text-muted)' }}><RefreshCw size={20} className="animate-spin mr-2" />扫描中...</div>
          ) : !data?.hasEntity ? (
            <div className="flex items-center justify-center h-full" style={{ color: 'var(--text-muted)' }}>该集合没有对应的实体类，无法进行字段匹配验证</div>
          ) : data.invalidItems.length === 0 ? (
            <div className="flex items-center justify-center h-full" style={{ color: 'rgba(34,197,94,0.9)' }}>所有文档字段匹配正常</div>
          ) : (
            <div className="p-4 space-y-4">
              {data.invalidItems.map((item, idx) => (
                <div key={idx} className="rounded-[10px] p-3" style={{ background: 'rgba(239,68,68,0.04)', border: '1px solid rgba(239,68,68,0.12)' }}>
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <div className="text-sm font-mono" style={{ color: 'var(--text-primary)' }}>ID: {item.documentId}</div>
                    <ConfirmTip title="确认删除？" description="将删除该文档（不可恢复）" confirmText="删除" onConfirm={() => handleDeleteDocument(item.documentId)} disabled={deleting === item.documentId}>
                      <Button variant="danger" size="xs" disabled={deleting === item.documentId}><Trash2 size={12} />删除</Button>
                    </ConfirmTip>
                  </div>
                  <div className="space-y-1 mb-2">
                    {item.issues.map((issue, i) => (<div key={i} className="text-xs flex items-center gap-2" style={{ color: 'rgba(239,68,68,0.9)' }}><AlertTriangle size={12} />{issue}</div>))}
                  </div>
                  <pre className="p-2 rounded-[6px] text-xs overflow-x-auto max-h-[150px]" style={{ background: 'rgba(0,0,0,0.2)', color: 'var(--text-secondary)' }}>{JSON.stringify(item.document, null, 2)}</pre>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <Button variant="secondary" size="sm" onClick={loadData} disabled={loading}><RefreshCw size={14} className={loading ? 'animate-spin' : ''} />重新扫描</Button>
        </div>
      </div>
    } />
  );
}

// 中栏对比行组件
function MappingRow({ mapping, onView, onValidate, onDelete, deleting }: { mapping: CollectionMappingItem; onView: () => void; onValidate: () => void; onDelete: () => void; deleting: boolean }) {
  const appDisplay = mapping.appOwners.length > 0 ? mapping.appOwners.map((a) => a.displayName).join(', ') : '无应用';
  const entityDisplay = mapping.hasEntity ? mapping.entityName : '无实体';
  const collectionDisplay = mapping.existsInDatabase ? mapping.collectionName : '无数据';
  const getStatusColor = () => {
    if (!mapping.existsInDatabase) return 'rgba(239,68,68,0.15)';
    if (!mapping.hasEntity) return 'rgba(239,68,68,0.1)';
    if (mapping.appOwners.length === 0) return 'rgba(168,85,247,0.1)';
    return 'rgba(255,255,255,0.02)';
  };
  const protectedCollections = ['users', 'llmplatforms', 'llmmodels', 'system_roles'];
  const isProtected = protectedCollections.includes(mapping.collectionName.toLowerCase());

  return (
    <div className="grid gap-3 items-center px-3 py-2.5 rounded-[10px] transition-colors hover:bg-white/3" style={{ gridTemplateColumns: '2fr 4fr 6fr', background: getStatusColor(), border: '1px solid rgba(255,255,255,0.05)' }}>
      <div className="min-w-0"><Badge variant={mapping.appOwners.length > 0 ? 'subtle' : 'danger'} size="sm">{appDisplay}</Badge></div>
      <div className="min-w-0">
        <div className="text-sm font-medium truncate" style={{ color: mapping.hasEntity ? 'var(--text-primary)' : 'rgba(239,68,68,0.8)' }}>{entityDisplay}</div>
        {mapping.entityFullName && <div className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>{mapping.entityFullName}</div>}
      </div>
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-mono truncate" style={{ color: mapping.existsInDatabase ? 'var(--text-primary)' : 'rgba(239,68,68,0.8)' }}>{collectionDisplay}</div>
          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{mapping.existsInDatabase ? `${fmtNum(mapping.documentCount)} 条` : '未创建'}</div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Tooltip content="查看数据" side="top"><Button variant="secondary" size="xs" disabled={!mapping.existsInDatabase || mapping.documentCount === 0} onClick={onView}><Eye size={13} /></Button></Tooltip>
          <Tooltip content="字段匹配验证" side="top"><Button variant="secondary" size="xs" disabled={!mapping.existsInDatabase || !mapping.hasEntity} onClick={onValidate}><Wrench size={13} /></Button></Tooltip>
          <ConfirmTip title="确认删除集合？" description={`将删除 ${mapping.collectionName} 集合及其所有数据（不可恢复）`} confirmText="删除" onConfirm={onDelete} disabled={!mapping.existsInDatabase || isProtected || deleting}>
            <Button variant="danger" size="xs" disabled={!mapping.existsInDatabase || isProtected || deleting}><Trash2 size={13} /></Button>
          </ConfirmTip>
        </div>
      </div>
    </div>
  );
}

export default function DataManagePage() {
  const [summary, setSummary] = useState<DataSummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [usersPurgeOpen, setUsersPurgeOpen] = useState(false);
  const [usersPurgeStep, setUsersPurgeStep] = useState<1 | 2>(1);
  const [usersPreviewLoading, setUsersPreviewLoading] = useState(false);
  const [usersPreview, setUsersPreview] = useState<AdminUsersPurgePreviewResponse | null>(null);
  const [usersConfirmText, setUsersConfirmText] = useState('');
  const [mappings, setMappings] = useState<CollectionMappingsResponse | null>(null);
  const [mappingsLoading, setMappingsLoading] = useState(false);
  const [selectedApp, setSelectedApp] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [deletingCollection, setDeletingCollection] = useState<string | null>(null);
  const [viewerCollection, setViewerCollection] = useState<string | null>(null);
  const [validationCollection, setValidationCollection] = useState<string | null>(null);

  const loadSummary = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const res = await getDataSummary();
      if (!res.success) { setErr(`${res.error?.code || 'ERROR'}：${res.error?.message || '加载失败'}`); return; }
      setSummary(res.data);
    } finally { setLoading(false); }
  }, []);

  const loadMappings = useCallback(async () => {
    setMappingsLoading(true);
    try {
      const res = await getCollectionMappings();
      if (res.success && res.data) setMappings(res.data);
    } finally { setMappingsLoading(false); }
  }, []);

  useEffect(() => { void loadSummary(); void loadMappings(); }, [loadSummary, loadMappings]);

  const filteredMappings = useMemo(() => {
    if (!mappings) return [];
    let list = mappings.mappings;
    if (selectedApp !== null) {
      if (selectedApp === '') list = list.filter((m) => m.appOwners.length === 0);
      else list = list.filter((m) => m.appOwners.some((a) => a.appName === selectedApp));
    }
    if (searchText.trim()) {
      const lower = searchText.toLowerCase();
      list = list.filter((m) => m.collectionName.toLowerCase().includes(lower) || (m.entityName && m.entityName.toLowerCase().includes(lower)));
    }
    return list;
  }, [mappings, selectedApp, searchText]);

  const doPurge = async (domains: string[]) => {
    setMsg(null); setErr(null);
    const idem = safeIdempotencyKey();
    const res = await purgeData({ domains }, idem);
    if (!res.success) { setErr(`${res.error?.code || 'ERROR'}：${res.error?.message || '清理失败'}`); return; }
    const isDevReset = domains.some((d) => d.toLowerCase().includes('devreset') || d.toLowerCase().includes('resetkeepmodels'));
    if (isDevReset) setMsg(`清理完成：开发重置（删除集合：${res.data.otherDeleted ?? 0}个，日志：${fmtNum(res.data.llmRequestLogs)}，消息：${fmtNum(res.data.messages)}，文档：${fmtNum(res.data.documents)}）`);
    else setMsg(`清理完成：${domains.join(', ')}（日志：${fmtNum(res.data.llmRequestLogs)}，消息：${fmtNum(res.data.messages)}，文档：${fmtNum(res.data.documents)}）`);
    await loadSummary(); await loadMappings();
  };

  const handleDeleteCollection = async (collectionName: string) => {
    setDeletingCollection(collectionName);
    try {
      const res = await deleteCollection(collectionName, true);
      if (res.success) { setMsg(`已删除集合：${collectionName}（${fmtNum(res.data.deletedDocuments)} 条文档）`); await loadMappings(); await loadSummary(); }
      else setErr(`删除失败：${res.error?.message || '未知错误'}`);
    } finally { setDeletingCollection(null); }
  };

  const handleDeleteAppData = async (appName: string) => {
    try {
      const res = await deleteAppData(appName, true);
      if (res.success) { setMsg(`已删除应用数据：${appName}（${res.data.deletedCollections.length} 个集合，${fmtNum(res.data.totalDeletedDocuments)} 条文档）`); await loadMappings(); await loadSummary(); }
      else setErr(`删除失败：${res.error?.message || '未知错误'}`);
    } catch { setErr('删除应用数据失败'); }
  };

  const openUsersPurge = async () => {
    setUsersPurgeOpen(true); setUsersPurgeStep(1); setUsersConfirmText(''); setUsersPreview(null); setUsersPreviewLoading(true);
    try {
      const res = await previewUsersPurge(20);
      if (!res.success) { setErr(`${res.error?.code || 'ERROR'}：${res.error?.message || '加载预览失败'}`); return; }
      setUsersPreview(res.data);
    } finally { setUsersPreviewLoading(false); }
  };

  const doPurgeUsers = async () => {
    setMsg(null); setErr(null);
    const idem = safeIdempotencyKey();
    const res = await purgeUsers({ confirmed: true }, idem);
    if (!res.success) { setErr(`${res.error?.code || 'ERROR'}：${res.error?.message || '清理失败'}`); return; }
    setMsg(`用户清理完成：删除用户 ${fmtNum(res.data.usersDeleted)} 个，群组成员 ${fmtNum(res.data.groupMembersDeleted)} 条`);
    setUsersPurgeOpen(false); await loadSummary();
  };

  const UserRow = ({ u }: { u: AdminUserPreviewItem }) => (
    <div className="grid gap-2 rounded-[10px] px-3 py-2.5 transition-colors hover:bg-white/3" style={{ gridTemplateColumns: '1.2fr 1fr 0.6fr 0.6fr 1fr', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
      <div className="min-w-0"><div className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{u.username || '-'}</div><div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>{u.displayName || '-'}</div></div>
      <div className="min-w-0 text-xs font-mono self-center truncate" style={{ color: 'var(--text-secondary)' }}>{u.userId?.slice(0, 8) || '-'}...</div>
      <div className="text-xs self-center" style={{ color: 'var(--text-secondary)' }}>{u.role}</div>
      <div className="text-xs self-center" style={{ color: 'var(--text-secondary)' }}>{u.status}</div>
      <div className="text-xs self-center" style={{ color: 'var(--text-muted)' }}>{fmtDate(u.createdAt)}</div>
    </div>
  );

  return (
    <div className="h-full min-h-0 flex flex-col gap-5 overflow-x-hidden overflow-y-auto">
      <TabBar title="数据管理" icon={<Database size={16} />} actions={<>
        <Button variant="secondary" size="sm" onClick={() => { void loadSummary(); void loadMappings(); }} disabled={loading || mappingsLoading}><RefreshCw size={14} className={loading || mappingsLoading ? 'animate-spin' : ''} />刷新</Button>
        <Button variant="primary" size="sm" onClick={() => setTransferOpen(true)}><Database size={14} />配置导入/导出</Button>
      </>} />

      {err && <div className="rounded-[12px] px-4 py-2.5 text-[13px] flex items-center gap-2.5" style={{ background: 'linear-gradient(135deg, rgba(239,68,68,0.08) 0%, rgba(239,68,68,0.04) 100%)', border: '1px solid rgba(239,68,68,0.2)', color: 'rgba(239,68,68,0.9)' }}><AlertTriangle size={15} />{err}</div>}
      {msg && <div className="rounded-[12px] px-4 py-2.5 text-[13px] flex items-center gap-2.5" style={{ background: 'linear-gradient(135deg, rgba(34,197,94,0.08) 0%, rgba(34,197,94,0.04) 100%)', border: '1px solid rgba(34,197,94,0.2)', color: 'rgba(34,197,94,0.9)' }}><Zap size={15} />{msg}</div>}

      {/* 上栏：统计 */}
      <GlassCard variant="gold" glow accentHue={45}>
        <div className="flex items-center justify-between gap-3 mb-4">
          <div><h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>数据统计</h2><p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>系统核心配置与业务数据概览</p></div>
          <div className="flex items-center gap-2">
            <Badge variant="subtle" size="sm">{mappings ? `${mappings.totalCollections} 集合` : '-'}</Badge>
            <Badge variant="subtle" size="sm">{mappings ? `${mappings.totalEntities} 实体` : '-'}</Badge>
          </div>
        </div>
        <div className="grid gap-2.5 grid-cols-2 lg:grid-cols-4">
          <StatCard icon={<Users size={18} />} label="用户账号" value={fmtNum(summary?.users ?? 0)} subValue="系统用户" accent="gold" loading={loading} />
          <StatCard icon={<Server size={18} />} label="LLM 平台" value={fmtNum(summary?.llmPlatforms ?? 0)} subValue="已配置平台" accent="blue" loading={loading} />
          <StatCard icon={<Zap size={18} />} label="启用模型" value={fmtNum(summary?.llmModelsEnabled ?? 0)} subValue={`共 ${fmtNum(summary?.llmModelsTotal ?? 0)} 个`} accent="green" loading={loading} />
          <StatCard icon={<MessageSquare size={18} />} label="消息总数" value={fmtNum((summary?.messages ?? 0) + (summary?.imageMasterMessages ?? 0))} subValue="PRD + 视觉创作" accent="purple" loading={loading} />
        </div>
      </GlassCard>

      {/* 中栏：实体与集合对比 */}
      <GlassCard glow accentHue={210}>
        <div className="flex items-center justify-between gap-3 mb-4">
          <div><h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>实体与集合对比</h2><p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>MongoDB 集合与 C# 实体类的映射关系</p></div>
          <div className="flex items-center gap-2">
            {mappings?.unmappedCollections ? <Badge variant="danger" size="sm">{mappings.unmappedCollections} 无实体</Badge> : null}
            {mappings?.unmappedEntities ? <Badge variant="warning" size="sm">{mappings.unmappedEntities} 无数据</Badge> : null}
          </div>
        </div>
        <div className="flex items-center gap-3 mb-4">
          <div className="flex-1 flex items-center gap-2 flex-wrap">
            <Button variant={selectedApp === null ? 'primary' : 'secondary'} size="xs" onClick={() => setSelectedApp(null)}>全部</Button>
            {mappings?.appStats.map((app) => (
              <Button key={app.appName ?? 'none'} variant={(selectedApp === (app.appName ?? '')) ? 'primary' : 'secondary'} size="xs" onClick={() => setSelectedApp(app.appName ?? '')}>
                {app.displayName}<Badge variant="subtle" size="sm" className="ml-1">{app.collectionCount}</Badge>
              </Button>
            ))}
          </div>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input type="text" value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="搜索集合或实体..." className="h-[32px] pl-9 pr-3 rounded-[8px] text-sm outline-none transition-all prd-field w-[200px]" />
          </div>
        </div>
        <div className="grid gap-3 items-center px-3 py-2 rounded-[8px] text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ gridTemplateColumns: '2fr 4fr 6fr', color: 'var(--text-muted)', background: 'rgba(255,255,255,0.03)' }}>
          <div>应用</div><div>实体类</div><div>集合名 / 操作</div>
        </div>
        <div className="space-y-1.5 max-h-[400px] overflow-y-auto">
          {mappingsLoading ? (
            <div className="flex items-center justify-center py-8" style={{ color: 'var(--text-muted)' }}><RefreshCw size={18} className="animate-spin mr-2" />扫描中...</div>
          ) : filteredMappings.length === 0 ? (
            <div className="text-center py-8 text-sm" style={{ color: 'var(--text-muted)' }}>无匹配结果</div>
          ) : (
            filteredMappings.map((mapping) => (
              <MappingRow key={mapping.collectionName} mapping={mapping} onView={() => setViewerCollection(mapping.collectionName)} onValidate={() => setValidationCollection(mapping.collectionName)} onDelete={() => handleDeleteCollection(mapping.collectionName)} deleting={deletingCollection === mapping.collectionName} />
            ))
          )}
        </div>
      </GlassCard>

      {/* 下栏：危险操作 */}
      <GlassCard glow accentHue={0} padding="lg">
        <div className="flex items-center gap-2 mb-4"><AlertTriangle size={16} style={{ color: 'rgba(239,68,68,0.75)' }} /><h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>危险操作</h2></div>
        <div className="grid gap-3 md:grid-cols-2">
          <DangerActionCard title="清理非管理员账号" description="删除所有非管理员用户账号及其关联数据，管理员账号将保留。此操作需要预览确认。" buttonText="预览并删除" onAction={openUsersPurge} loading={loading} />
          <DangerActionCard title="开发期一键重置" description="删除 users/llmplatforms/启用的 llmmodels 之外的所有集合数据，并清理未启用的模型配置。" buttonText="一键删除" onAction={async () => { await doPurge(['devReset']); }} loading={loading} confirmTitle="确认执行开发清库？" confirmDescription="将删除除 users / llmplatforms / 启用 llmmodels 外的所有数据，并清掉相关缓存（不可恢复）。" />
          {selectedApp && selectedApp !== '' && selectedApp !== 'system' && (
            <DangerActionCard title={`删除 ${mappings?.appStats.find((a) => a.appName === selectedApp)?.displayName || selectedApp} 应用数据`} description="删除该应用独享的所有集合数据（共享集合不会被删除）。" buttonText="删除应用数据" onAction={async () => { await handleDeleteAppData(selectedApp); }} loading={loading} confirmTitle={`确认删除 ${selectedApp} 应用数据？`} confirmDescription="将删除该应用独享的所有集合数据（共享集合不受影响）。" />
          )}
        </div>
      </GlassCard>

      {/* 用户清理弹窗 */}
      <Dialog open={usersPurgeOpen} onOpenChange={(open) => { setUsersPurgeOpen(open); if (!open) { setUsersPurgeStep(1); setUsersConfirmText(''); setUsersPreview(null); } }} title={usersPurgeStep === 1 ? '预览：清理用户数据' : '二次确认：删除用户数据'} description={usersPurgeStep === 1 ? '将删除非管理员用户账号（ADMIN 保留）。' : '该操作不可恢复。'} maxWidth={900} content={
        <div className="min-h-0 flex flex-col gap-4">
          {usersPurgeStep === 1 ? (<>
            <div className="rounded-[12px] p-4" style={{ background: 'linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(0,0,0,0.08) 100%)', border: '1px solid rgba(255,255,255,0.08)' }}>
              {usersPreviewLoading ? (<div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}><RefreshCw size={14} className="animate-spin" />加载预览中...</div>) : usersPreview ? (
                <div className="grid grid-cols-4 gap-4">
                  <div><div className="text-xs" style={{ color: 'var(--text-muted)' }}>总用户</div><div className="text-xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>{fmtNum(usersPreview.totalUsers)}</div></div>
                  <div><div className="text-xs" style={{ color: 'var(--text-muted)' }}>管理员</div><div className="text-xl font-bold mt-1" style={{ color: 'rgba(34,197,94,0.95)' }}>{fmtNum(usersPreview.adminUsers)}</div></div>
                  <div><div className="text-xs" style={{ color: 'var(--text-muted)' }}>将删除</div><div className="text-xl font-bold mt-1" style={{ color: 'rgba(239,68,68,0.95)' }}>{fmtNum(usersPreview.willDeleteUsers)}</div></div>
                  <div><div className="text-xs" style={{ color: 'var(--text-muted)' }}>将保留</div><div className="text-xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>{fmtNum(usersPreview.willKeepUsers)}</div></div>
                </div>
              ) : (<div className="text-sm" style={{ color: 'var(--text-muted)' }}>暂无预览数据</div>)}
            </div>
            {usersPreview?.notes?.length ? <div className="text-xs space-y-1" style={{ color: 'var(--text-muted)' }}>{usersPreview.notes.map((t, idx) => <div key={idx}>- {t}</div>)}</div> : null}
            <div className="space-y-2">
              <div className="flex items-center gap-2"><Users size={14} style={{ color: 'rgba(239,68,68,0.75)' }} /><span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>将删除的用户（示例）</span></div>
              <div className="rounded-[12px] p-3 space-y-2 max-h-[200px] overflow-y-auto" style={{ background: 'rgba(0,0,0,0.15)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="grid gap-2 px-3 py-2 rounded-[8px] text-[10px] font-semibold uppercase tracking-wider" style={{ gridTemplateColumns: '1.2fr 1fr 0.6fr 0.6fr 1fr', color: 'var(--text-muted)', background: 'rgba(255,255,255,0.03)' }}><div>账号</div><div>UserId</div><div>Role</div><div>Status</div><div>CreatedAt</div></div>
                {usersPreviewLoading ? <div className="text-sm py-4 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div> : usersPreview?.sampleWillDeleteUsers?.length ? usersPreview.sampleWillDeleteUsers.map((u) => <UserRow key={u.userId} u={u} />) : <div className="text-sm py-4 text-center" style={{ color: 'var(--text-muted)' }}>无（可能只有管理员账号）</div>}
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2"><Users size={14} style={{ color: 'rgba(34,197,94,0.75)' }} /><span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>将保留的管理员（示例）</span></div>
              <div className="rounded-[12px] p-3 space-y-2 max-h-[150px] overflow-y-auto" style={{ background: 'rgba(0,0,0,0.15)', border: '1px solid rgba(255,255,255,0.06)' }}>
                {usersPreview?.sampleWillKeepAdmins?.length ? usersPreview.sampleWillKeepAdmins.map((u) => <UserRow key={u.userId} u={u} />) : <div className="text-sm py-4 text-center" style={{ color: 'var(--text-muted)' }}>无管理员账号（异常）</div>}
              </div>
            </div>
          </>) : (<>
            <div className="rounded-[12px] px-4 py-3 text-sm flex items-center gap-3" style={{ background: 'linear-gradient(135deg, rgba(239,68,68,0.15) 0%, rgba(239,68,68,0.08) 100%)', border: '1px solid rgba(239,68,68,0.30)', color: 'rgba(239,68,68,0.95)' }}><AlertTriangle size={18} />将删除非管理员用户账号，该操作不可恢复。</div>
            <div className="space-y-3"><div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>请输入 <code className="px-1.5 py-0.5 rounded bg-white/5 font-mono">DELETE</code> 以确认</div><input value={usersConfirmText} onChange={(e) => setUsersConfirmText(e.target.value)} placeholder="DELETE" className="w-full h-[44px] rounded-[12px] px-4 text-sm outline-none transition-all prd-field" autoFocus /></div>
          </>)}
          <div className="pt-3 flex items-center justify-end gap-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <Button variant="secondary" size="sm" onClick={() => { if (usersPurgeStep === 1) setUsersPurgeOpen(false); else { setUsersPurgeStep(1); setUsersConfirmText(''); } }}>{usersPurgeStep === 1 ? '取消' : '返回预览'}</Button>
            {usersPurgeStep === 1 ? <Button variant="primary" size="sm" disabled={usersPreviewLoading} onClick={() => setUsersPurgeStep(2)}>下一步</Button> : <Button variant="danger" size="sm" disabled={usersConfirmText !== 'DELETE' || loading} onClick={doPurgeUsers}>确认删除</Button>}
          </div>
        </div>
      } />

      <DataTransferDialog open={transferOpen} onOpenChange={setTransferOpen} onImported={async () => { await loadSummary(); }} />
      <CollectionDataViewerDialog open={!!viewerCollection} onOpenChange={(open) => !open && setViewerCollection(null)} collectionName={viewerCollection || ''} />
      <CollectionValidationDialog open={!!validationCollection} onOpenChange={(open) => !open && setValidationCollection(null)} collectionName={validationCollection || ''} onRefresh={() => void loadMappings()} />
    </div>
  );
}
