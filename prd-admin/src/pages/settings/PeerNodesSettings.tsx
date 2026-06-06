/**
 * 「系统互联」Tab — 系统设置内的管理员视图。
 *
 * 管理员配一次对端节点（测试↔正式环境），两节点自动握手交换长期密钥，
 * 此后用户在知识库等应用「发送到 →」即可一键互传，无需再手动倒密钥。
 * 详见 doc/design.peer-sync.md。
 */

import { useCallback, useEffect, useState } from 'react';
import { Globe, Plus, Copy, Check, Trash2, RefreshCw, Wifi, KeyRound, X } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import {
  listAdminPeerNodes,
  generatePairingCode,
  addPeerNode,
  testPeerNode,
  deletePeerNode,
  type PeerNode,
} from '@/services/real/peerSync';

function fmtDate(s?: string | null) {
  if (!s) return '-';
  try {
    return new Date(s).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return s;
  }
}

function statusBadge(status: PeerNode['status']) {
  if (status === 'connected') return <Badge variant="success">已连接</Badge>;
  if (status === 'error') return <Badge variant="danger">通信异常</Badge>;
  return <Badge variant="subtle">待握手</Badge>;
}

export function PeerNodesSettings() {
  const [nodes, setNodes] = useState<PeerNode[]>([]);
  const [selfNodeId, setSelfNodeId] = useState('');
  const [selfBaseUrl, setSelfBaseUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // 配对码
  const [code, setCode] = useState<string | null>(null);
  const [genBusy, setGenBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // 添加对端表单
  const [showAdd, setShowAdd] = useState(false);
  const [addBaseUrl, setAddBaseUrl] = useState('');
  const [addCode, setAddCode] = useState('');
  const [addName, setAddName] = useState('');
  const [addSelfName, setAddSelfName] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 2600);
  };

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listAdminPeerNodes();
    if (res.success && res.data) {
      setNodes(res.data.items || []);
      setSelfNodeId(res.data.selfNodeId);
      setSelfBaseUrl(res.data.selfBaseUrl);
    } else {
      flash(res.error?.message || '加载失败');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleGenCode = async () => {
    setGenBusy(true);
    const res = await generatePairingCode();
    setGenBusy(false);
    if (res.success && res.data) {
      setCode(res.data.pairingCode);
      setCopied(false);
    } else {
      flash(res.error?.message || '生成失败');
    }
  };

  const handleCopyCode = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      flash('复制失败，请手动选择复制');
    }
  };

  const handleAdd = async () => {
    if (!addBaseUrl.trim() || !addCode.trim()) {
      setAddError('请填写对端地址和配对码');
      return;
    }
    setAddBusy(true);
    setAddError(null);
    const res = await addPeerNode({
      baseUrl: addBaseUrl.trim(),
      pairingCode: addCode.trim(),
      displayName: addName.trim() || undefined,
      selfDisplayName: addSelfName.trim() || undefined,
    });
    setAddBusy(false);
    if (res.success) {
      flash('配对成功');
      setShowAdd(false);
      setAddBaseUrl('');
      setAddCode('');
      setAddName('');
      setAddSelfName('');
      void load();
    } else {
      setAddError(res.error?.message || '配对失败');
    }
  };

  const handleTest = async (id: string) => {
    setBusyId(id);
    const res = await testPeerNode(id);
    setBusyId(null);
    if (res.success && res.data?.ok) flash('连通正常');
    else flash(res.data?.error || '连通失败，请检查对端地址与配对状态');
    void load();
  };

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`确定解除与「${name}」的配对？仅删除本端记录，对端需自行删除。`)) return;
    setBusyId(id);
    const res = await deletePeerNode(id);
    setBusyId(null);
    if (res.success) {
      flash('已解除配对');
      void load();
    } else {
      flash(res.error?.message || '删除失败');
    }
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-4 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
      {/* 说明 + 本节点身份 */}
      <GlassCard className="p-4">
        <div className="flex items-start gap-3">
          <Globe size={18} className="text-white/60 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">系统互联（跨节点互传）</div>
            <div className="text-xs text-white/50 mt-1 leading-relaxed">
              配置对端 MAP 节点（如测试环境 ↔ 正式环境）。配对一次后，用户在知识库等应用右上角「发送到」即可一键互传，
              无需在两个环境之间手动复制密钥。配对走一次性配对码 + HMAC 签名，密钥永不在前端 / 链接中暴露。
            </div>
            <div className="mt-2 text-[11px] text-white/40 font-mono break-all">
              本节点标识：{selfNodeId || '...'} | 对外地址：{selfBaseUrl || '...'}
            </div>
          </div>
        </div>
      </GlassCard>

      {/* 配对码生成 */}
      <GlassCard className="p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <KeyRound size={15} className="text-white/60" />
            <span className="text-sm">让对端连接本节点</span>
          </div>
          <Button size="sm" variant="secondary" onClick={handleGenCode} disabled={genBusy}>
            {genBusy ? <MapSpinner size={14} /> : <KeyRound size={14} />}
            生成配对码
          </Button>
        </div>
        {code && (
          <div className="mt-3 rounded-lg border border-white/10 bg-white/5 p-3">
            <div className="text-[11px] text-white/45 mb-1.5">
              把下面这串配对码 + 本节点对外地址发给对端管理员，让对端在「系统互联 → 添加对端节点」里粘贴（5 分钟内有效，仅用一次）：
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono break-all bg-black/20 rounded px-2 py-1.5">{code}</code>
              <Button size="sm" variant="ghost" onClick={handleCopyCode}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </Button>
            </div>
            <div className="mt-1.5 text-[11px] text-white/40 font-mono break-all">对外地址：{selfBaseUrl}</div>
          </div>
        )}
      </GlassCard>

      {/* 对端节点列表 */}
      <div className="flex items-center justify-between">
        <div className="text-sm text-white/70">已配对节点</div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={14} />
          </Button>
          <Button size="sm" onClick={() => setShowAdd((v) => !v)}>
            <Plus size={14} /> 添加对端节点
          </Button>
        </div>
      </div>

      {showAdd && (
        <GlassCard className="p-4">
          <div className="text-sm font-medium mb-3">添加对端节点</div>
          <div className="grid gap-3">
            <label className="grid gap-1">
              <span className="text-xs text-white/50">对端地址（baseUrl）</span>
              <input
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:border-white/30"
                placeholder="https://prod-xxx.miduo.org"
                value={addBaseUrl}
                onChange={(e) => setAddBaseUrl(e.target.value)}
              />
            </label>
            <label className="grid gap-1">
              <span className="text-xs text-white/50">对端生成的配对码</span>
              <input
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:border-white/30 font-mono"
                placeholder="粘贴对端管理员发来的配对码"
                value={addCode}
                onChange={(e) => setAddCode(e.target.value)}
              />
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="grid gap-1">
                <span className="text-xs text-white/50">我方称呼对端（可选）</span>
                <input
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:border-white/30"
                  placeholder="如：正式环境"
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                />
              </label>
              <label className="grid gap-1">
                <span className="text-xs text-white/50">对端称呼本节点（可选）</span>
                <input
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:border-white/30"
                  placeholder="如：测试环境"
                  value={addSelfName}
                  onChange={(e) => setAddSelfName(e.target.value)}
                />
              </label>
            </div>
            {addError && <div className="text-xs text-red-400">{addError}</div>}
            <div className="flex items-center gap-2 justify-end">
              <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>
                取消
              </Button>
              <Button size="sm" onClick={handleAdd} disabled={addBusy}>
                {addBusy ? <MapSpinner size={14} /> : <Wifi size={14} />}
                配对
              </Button>
            </div>
          </div>
        </GlassCard>
      )}

      {loading ? (
        <MapSectionLoader text="正在加载对端节点…" />
      ) : nodes.length === 0 ? (
        <GlassCard className="p-8 text-center">
          <Globe size={28} className="mx-auto text-white/25" />
          <div className="mt-3 text-sm text-white/60">还没有配对任何对端节点</div>
          <div className="mt-1 text-xs text-white/40">
            点「生成配对码」发给对端，或拿到对端配对码后点「添加对端节点」即可打通两个环境。
          </div>
        </GlassCard>
      ) : (
        <div className="grid gap-2">
          {nodes.map((n) => (
            <GlassCard key={n.id} className="p-3.5">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3 min-w-0">
                  <Globe size={16} className="text-white/50 shrink-0" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{n.displayName}</span>
                      {statusBadge(n.status)}
                    </div>
                    <div className="text-[11px] text-white/40 font-mono truncate">{n.baseUrl}</div>
                    {n.lastError && <div className="text-[11px] text-red-400/80 mt-0.5 truncate">{n.lastError}</div>}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-white/35 mr-1">最近通信 {fmtDate(n.lastContactAt)}</span>
                  <Button size="sm" variant="ghost" onClick={() => handleTest(n.id)} disabled={busyId === n.id}>
                    {busyId === n.id ? <MapSpinner size={14} /> : <Wifi size={14} />}
                    测试
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => handleDelete(n.id, n.displayName)} disabled={busyId === n.id}>
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
            </GlassCard>
          ))}
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] rounded-lg bg-black/80 px-4 py-2 text-sm text-white shadow-lg flex items-center gap-2">
          <span>{toast}</span>
          <button onClick={() => setToast(null)} className="text-white/50 hover:text-white">
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
