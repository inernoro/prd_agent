/**
 * 「系统互联」Tab — 系统设置内的管理员视图。
 *
 * 管理员配一次对端节点（测试↔正式环境），两节点自动握手交换长期密钥，
 * 此后用户在知识库等应用「发送到 →」即可一键互传，无需再手动倒密钥。
 * 详见 doc/design.peer-sync.md。
 *
 * 设计要点（基于 2026-06-07 真人验收反馈打磨）：
 * 1. 本节点身份明显可见且可复制（旧版用 11px mono 灰字塞在角落）
 * 2. 主流程收敛为一个「添加对端」入口，任一端粘贴对方连接串后由系统完成双向确认
 * 3. 已配对节点卡片改用图标 + 状态点 + 时间 + 内联动作，错误自动展开真因
 * 4. 严格遵守 cds-theme-tokens.md：颜色全部走 var(--*) token
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Globe,
  Plus,
  Copy,
  Check,
  Trash2,
  RefreshCw,
  Wifi,
  KeyRound,
  X,
  ArrowRight,
  AlertCircle,
  CheckCircle2,
  Server,
} from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import {
  listAdminPeerNodes,
  generatePairingCode,
  addPeerNode,
  testPeerNode,
  deletePeerNode,
  type PeerNode,
} from '@/services/real/peerSync';

function fmtRelative(s?: string | null) {
  if (!s) return '从未';
  try {
    const ms = Date.now() - new Date(s).getTime();
    if (ms < 60_000) return '刚刚';
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`;
    return new Date(s).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return s;
  }
}

function StatusDot({ status }: { status: PeerNode['status'] }) {
  const colorVar =
    status === 'connected'
      ? 'rgba(34,197,94,0.95)'
      : status === 'error'
        ? 'rgba(239,68,68,0.95)'
        : 'rgba(245,158,11,0.95)';
  const label = status === 'connected' ? '已连接' : status === 'error' ? '通信异常' : '待握手';
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full"
      style={{
        background:
          status === 'connected'
            ? 'rgba(34,197,94,0.10)'
            : status === 'error'
              ? 'rgba(239,68,68,0.10)'
              : 'rgba(245,158,11,0.10)',
        color: colorVar,
      }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: colorVar, boxShadow: `0 0 6px ${colorVar}` }} />
      {label}
    </span>
  );
}

function CopyChip({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          /* ignore */
        }
      }}
      className="group inline-flex items-center gap-1.5 max-w-full text-left rounded-md px-2 py-1 transition-colors"
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        color: 'var(--text-primary)',
      }}
      title={`点击复制 ${label}`}
    >
      <span className="text-[10px] font-medium shrink-0" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <code className="text-[11px] font-mono truncate min-w-0" style={{ color: 'var(--text-primary)' }}>
        {value || '—'}
      </code>
      {copied ? (
        <Check size={11} style={{ color: 'rgba(34,197,94,0.95)' }} className="shrink-0" />
      ) : (
        <Copy size={11} className="shrink-0 opacity-40 group-hover:opacity-90 transition-opacity" style={{ color: 'var(--text-muted)' }} />
      )}
    </button>
  );
}

type PeerConnectPayload = {
  kind: 'peer-connect';
  version: 1;
  nodeId: string;
  baseUrl: string;
  pairingCode: string;
  expiresAt: string;
  displayName?: string;
};

function toBase64Url(json: string) {
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(s: string) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function buildPeerConnectString(payload: PeerConnectPayload) {
  return `peer-connect:v1:${toBase64Url(JSON.stringify(payload))}`;
}

function parsePeerConnectString(text: string): PeerConnectPayload {
  const raw = text.trim();
  if (!raw.startsWith('peer-connect:v1:')) {
    throw new Error('请粘贴 peer-connect:v1 开头的对端连接串');
  }
  const payload = JSON.parse(fromBase64Url(raw.slice('peer-connect:v1:'.length))) as Partial<PeerConnectPayload>;
  if (payload.kind !== 'peer-connect' || payload.version !== 1) throw new Error('连接串版本不正确');
  if (!payload.nodeId || !payload.baseUrl || !payload.pairingCode || !payload.expiresAt) {
    throw new Error('连接串缺少节点标识、地址或密钥');
  }
  if (Date.parse(payload.expiresAt) <= Date.now()) throw new Error('对端连接串已过期，请让对端重新生成');
  return payload as PeerConnectPayload;
}

export function PeerNodesSettings() {
  const [nodes, setNodes] = useState<PeerNode[]>([]);
  const [selfNodeId, setSelfNodeId] = useState('');
  const [selfBaseUrl, setSelfBaseUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null);

  // 连接串里的短期配对密钥
  const [code, setCode] = useState<string | null>(null);
  const [codeExpiresAt, setCodeExpiresAt] = useState<number | null>(null);
  const [genBusy, setGenBusy] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  // 添加对端
  const [showAdd, setShowAdd] = useState(false);
  const [peerConnectText, setPeerConnectText] = useState('');
  const [parsedPeer, setParsedPeer] = useState<PeerConnectPayload | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [addName, setAddName] = useState('');
  const [addSelfName, setAddSelfName] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addProgress, setAddProgress] = useState<{ stage: string; startedAt: number } | null>(null);
  const [testProgress, setTestProgress] = useState<{ id: string; startedAt: number } | null>(null);
  const [, setNow] = useState(0);
  // 1s 节拍器：handshake/test 进行中 或 连接串倒计时显示时驱动「已用 Xs / 剩余 Xs」自增显示
  useEffect(() => {
    if (!addBusy && !testProgress && !code) return;
    const t = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [addBusy, testProgress, code]);

  const flash = (msg: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 2800);
  };

  // PR #742 review fix: 工具栏刷新 / test/delete/add 后续 load 可能并发，旧响应若回填会
  // 覆盖较新的节点状态或错误。用单调序号守卫：只有"最新一次"调用允许 setState。
  // 沿用 prd-admin learned rule: 由用户动作触发的 async fetch 必须有 fetchIdRef stale 保护。
  // PR #742 review Low fix：补 isMountedRef 卸载守卫（用户切到别的 settings tab）。
  const loadSeqRef = useRef(0);
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);
  const load = useCallback(async () => {
    const mySeq = ++loadSeqRef.current;
    setLoading(true);
    const res = await listAdminPeerNodes();
    if (mySeq !== loadSeqRef.current || !isMountedRef.current) return;
    if (res.success && res.data) {
      setNodes(res.data.items || []);
      setSelfNodeId(res.data.selfNodeId);
      setSelfBaseUrl(res.data.selfBaseUrl);
    } else {
      flash(res.error?.message || '加载失败', 'err');
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
      setCodeExpiresAt(Date.now() + (res.data.expiresInSeconds || 300) * 1000);
      setSelfNodeId(res.data.selfNodeId);
      setSelfBaseUrl(res.data.selfBaseUrl);
      setCopiedCode(false);
    } else {
      flash(res.error?.message || '生成失败', 'err');
    }
  };

  const handleCopyCode = async () => {
    if (!selfConnectText) return;
    try {
      await navigator.clipboard.writeText(selfConnectText);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      flash('复制失败，请手动选择复制', 'err');
    }
  };

  const handlePeerConnectTextChange = (value: string) => {
    setPeerConnectText(value);
    setAddError(null);
    if (!value.trim()) {
      setParsedPeer(null);
      setParseError(null);
      return;
    }
    try {
      const parsed = parsePeerConnectString(value);
      setParsedPeer(parsed);
      setParseError(null);
      if (!addName.trim() && parsed.displayName) setAddName(parsed.displayName);
    } catch (ex) {
      setParsedPeer(null);
      setParseError(ex instanceof Error ? ex.message : '连接串无法解析');
    }
  };

  const handleAdd = async () => {
    let parsed: PeerConnectPayload;
    try {
      parsed = parsePeerConnectString(peerConnectText);
    } catch (ex) {
      setAddError(ex instanceof Error ? ex.message : '请粘贴有效的对端连接串');
      return;
    }
    setAddBusy(true);
    setAddError(null);
    const startedAt = Date.now();
    setAddProgress({ stage: '正在与对端发起握手…', startedAt });
    // 阶段提示节奏：避免单一 spinner，让用户知道系统在做什么
    const t1 = setTimeout(() => setAddProgress({ stage: '对端正在校验连接串 + 生成共享密钥…', startedAt }), 1500);
    const t2 = setTimeout(() => setAddProgress({ stage: '交换 HMAC 密钥并落地配对记录…', startedAt }), 4000);
    const t3 = setTimeout(() => setAddProgress({ stage: '对端响应较慢，仍在等待…', startedAt }), 8000);
    try {
      const res = await addPeerNode({
        baseUrl: parsed.baseUrl.trim(),
        pairingCode: parsed.pairingCode.trim(),
        displayName: addName.trim() || parsed.displayName || undefined,
        selfDisplayName: addSelfName.trim() || undefined,
      });
      if (!isMountedRef.current) return; // PR #742 review Low fix
      if (res.success) {
        const elapsed = Math.round((Date.now() - startedAt) / 100) / 10;
        flash(`互联成功（耗时 ${elapsed}s）`);
        setShowAdd(false);
        setPeerConnectText('');
        setParsedPeer(null);
        setParseError(null);
        setAddName('');
        setAddSelfName('');
        void load();
      } else {
        // PR #742 review Medium fix：若用户在 in-flight 时点过"收起表单"（被本提交的 disabled 兜底拦下时尤其要兜底），
        // addError 渲染在 showAdd 块里看不到，再 flash 一条 toast 确保失败原因可见。
        const msg = res.error?.message || '配对失败';
        setAddError(msg);
        flash(msg, 'err');
      }
    } catch (ex) {
      if (!isMountedRef.current) return;
      const msg = ex instanceof Error ? ex.message : '配对失败';
      setAddError(msg);
      flash(msg, 'err');
    } finally {
      clearTimeout(t1); clearTimeout(t2); clearTimeout(t3);
      if (isMountedRef.current) {
        setAddBusy(false);
        setAddProgress(null);
      }
    }
  };

  const handleTest = async (id: string) => {
    setBusyId(id);
    const startedAt = Date.now();
    setTestProgress({ id, startedAt });
    const res = await testPeerNode(id);
    if (!isMountedRef.current) return; // PR #742 review Low fix
    setBusyId(null);
    setTestProgress(null);
    const elapsed = Math.round((Date.now() - startedAt) / 100) / 10;
    if (res.success && res.data?.ok) flash(`连通正常（${elapsed}s）`);
    else flash(`${res.data?.error || '连通失败，请稍后重试或检查对端配对状态'}（${elapsed}s）`, 'err');
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
      flash(res.error?.message || '删除失败', 'err');
    }
  };

  const codeSecondsLeft = codeExpiresAt ? Math.max(0, Math.ceil((codeExpiresAt - Date.now()) / 1000)) : 0;
  const selfConnectText = code && codeExpiresAt
    ? buildPeerConnectString({
        kind: 'peer-connect',
        version: 1,
        nodeId: selfNodeId,
        baseUrl: selfBaseUrl,
        pairingCode: code,
        expiresAt: new Date(codeExpiresAt).toISOString(),
      })
    : '';

  return (
    <div
      className="h-full min-h-0 flex flex-col gap-5 overflow-y-auto pb-6"
      style={{ overscrollBehavior: 'contain' }}
    >
      {/* ── 本节点身份卡（hero） ── */}
      <section
        className="relative rounded-2xl overflow-hidden p-5"
        style={{
          background:
            'linear-gradient(135deg, rgba(99,102,241,0.10) 0%, rgba(59,130,246,0.06) 50%, rgba(236,72,153,0.06) 100%)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <div className="flex items-start gap-4 flex-wrap">
          <div
            className="shrink-0 w-11 h-11 rounded-xl flex items-center justify-center"
            style={{ background: 'rgba(99,102,241,0.18)', border: '1px solid rgba(99,102,241,0.30)' }}
          >
            <Server size={20} style={{ color: 'rgba(165,180,252,0.95)' }} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                本节点
              </span>
              <span
                className="text-[10px] px-1.5 py-0.5 rounded"
                style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}
              >
                {nodes.length} 个对端已配对
              </span>
            </div>
            <p className="text-[12px] mb-3 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              管理员一次配置对端节点（测试 ↔ 正式环境），用户即可在知识库等应用右上角「发送到」一键互传。
              配对走一次性码 + HMAC 签名，共享密钥永不在前端 / 链接中暴露。
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <CopyChip value={selfNodeId} label="节点标识" />
              <CopyChip value={selfBaseUrl} label="对外地址" />
            </div>
          </div>
        </div>
      </section>

      {/* ── 添加对端 ── */}
      <section
        className="rounded-xl p-4 space-y-3"
        style={{
          background: 'var(--bg-card, rgba(255,255,255,0.03))',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-start gap-3 min-w-0">
            <div
              className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center"
              style={{ background: 'rgba(99,102,241,0.14)', border: '1px solid rgba(99,102,241,0.24)' }}
            >
              <Plus size={16} style={{ color: 'rgba(165,180,252,0.95)' }} />
            </div>
            <div className="min-w-0">
              <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                添加对端
              </div>
              <div className="text-[11px] mt-0.5 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                任一端拿到对方生成的连接串后粘贴并点击添加；系统双向确认和探活成功后，双方才会保存为已互联。
              </div>
            </div>
          </div>
          <Button size="sm" onClick={() => { if (!addBusy) setShowAdd((v) => !v); }} disabled={addBusy}>
            <Plus size={13} /> {showAdd ? (addBusy ? '添加中…' : '收起') : '添加对端'}
          </Button>
        </div>
      </section>

      {showAdd && (
        <section
          className="rounded-xl p-4 space-y-3"
          style={{
            background: 'var(--bg-card, rgba(255,255,255,0.03))',
            border: '1px solid rgba(168,85,247,0.20)',
          }}
        >
          <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
            添加对端
          </div>

          <div
            className="rounded-lg p-3 space-y-2"
            style={{ background: 'rgba(59,130,246,0.05)', border: '1px solid rgba(59,130,246,0.16)' }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                我的连接串
              </span>
              {code && (
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  剩余 {codeSecondsLeft}s
                </span>
              )}
            </div>
            {selfConnectText ? (
              <>
                <code
                  className="block text-[11px] font-mono break-all px-2 py-2 rounded max-h-20 overflow-y-auto"
                  style={{ background: 'rgba(0,0,0,0.22)', color: 'var(--text-primary)' }}
                >
                  {selfConnectText}
                </code>
                <div className="flex items-center justify-end gap-2">
                  <Button size="xs" variant="ghost" onClick={handleGenCode} disabled={genBusy}>
                    {genBusy ? <MapSpinner size={12} /> : <KeyRound size={12} />}
                    重新生成
                  </Button>
                  <Button size="xs" variant="secondary" onClick={handleCopyCode}>
                    {copiedCode ? <Check size={12} /> : <Copy size={12} />}
                    {copiedCode ? '已复制' : '复制'}
                  </Button>
                </div>
              </>
            ) : (
              <Button size="sm" variant="secondary" onClick={handleGenCode} disabled={genBusy} className="w-full">
                {genBusy ? <MapSpinner size={13} /> : <KeyRound size={13} />}
                生成我的连接串
              </Button>
            )}
          </div>

          <label className="grid gap-1.5">
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              对端连接串
            </span>
            <textarea
              className="w-full min-h-[92px] resize-y rounded-lg px-3 py-2 text-[12px] font-mono outline-none"
              style={{
                background: 'var(--bg-input, rgba(255,255,255,0.04))',
                border: '1px solid rgba(255,255,255,0.10)',
                color: 'var(--text-primary)',
              }}
              placeholder="粘贴对端生成的 peer-connect:v1:..."
              value={peerConnectText}
              onChange={(e) => handlePeerConnectTextChange(e.target.value)}
            />
          </label>

          {(parsedPeer || parseError) && (
            <div
              className="flex items-start gap-2 text-[12px] rounded-lg px-3 py-2"
              style={{
                background: parsedPeer ? 'rgba(34,197,94,0.07)' : 'rgba(239,68,68,0.08)',
                border: `1px solid ${parsedPeer ? 'rgba(34,197,94,0.18)' : 'rgba(239,68,68,0.20)'}`,
                color: parsedPeer ? 'rgba(134,239,172,0.95)' : 'rgba(252,165,165,0.95)',
              }}
            >
              {parsedPeer ? <CheckCircle2 size={14} className="shrink-0 mt-0.5" /> : <AlertCircle size={14} className="shrink-0 mt-0.5" />}
              <span className="min-w-0 break-words">
                {parsedPeer
                  ? `已识别对端 ${parsedPeer.displayName || parsedPeer.nodeId} · ${parsedPeer.baseUrl}`
                  : parseError}
              </span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="grid gap-1.5">
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                我方称呼对端（可选）
              </span>
              <input
                className="w-full rounded-lg px-3 py-2 text-[13px] outline-none"
                style={{
                  background: 'var(--bg-input, rgba(255,255,255,0.04))',
                  border: '1px solid rgba(255,255,255,0.10)',
                  color: 'var(--text-primary)',
                }}
                placeholder="如：正式环境"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
              />
            </label>
            <label className="grid gap-1.5">
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                对端称呼本节点（可选）
              </span>
              <input
                className="w-full rounded-lg px-3 py-2 text-[13px] outline-none"
                style={{
                  background: 'var(--bg-input, rgba(255,255,255,0.04))',
                  border: '1px solid rgba(255,255,255,0.10)',
                  color: 'var(--text-primary)',
                }}
                placeholder="如：测试环境"
                value={addSelfName}
                onChange={(e) => setAddSelfName(e.target.value)}
              />
            </label>
          </div>
          {addError && (
            <div
              className="flex items-start gap-2 text-[12px] rounded-lg px-3 py-2"
              style={{
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.20)',
                color: 'rgba(252,165,165,0.95)',
              }}
            >
              <AlertCircle size={14} className="shrink-0 mt-0.5" />
              <span className="min-w-0 break-words">{addError}</span>
            </div>
          )}
          {addBusy && addProgress && (
            <div
              className="flex items-start gap-2 text-[12px] rounded-lg px-3 py-2"
              style={{
                background: 'rgba(59,130,246,0.06)',
                border: '1px solid rgba(59,130,246,0.18)',
                color: 'rgba(147,197,253,0.95)',
              }}
            >
              <MapSpinner size={12} />
              <span className="min-w-0 flex-1">
                {addProgress.stage}{' '}
                <span style={{ color: 'rgba(147,197,253,0.6)' }}>
                  · 已用 {Math.round((Date.now() - addProgress.startedAt) / 1000)}s
                </span>
              </span>
            </div>
          )}
          <div className="flex items-center gap-2 justify-end pt-1">
            <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)} disabled={addBusy}>
              取消
            </Button>
            <Button size="sm" onClick={handleAdd} disabled={addBusy || !!parseError || !peerConnectText.trim()}>
              {addBusy ? <MapSpinner size={13} /> : <Wifi size={13} />}
              {addBusy ? '添加中…' : '添加'}
            </Button>
          </div>
        </section>
      )}

      {/* ── 已配对节点 ── */}
      <section className="space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
              已配对节点
            </span>
            {!loading && (
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {nodes.length} 个
              </span>
            )}
          </div>
          <Button size="xs" variant="ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </Button>
        </div>

        {loading ? (
          <MapSectionLoader text="正在加载对端节点…" />
        ) : nodes.length === 0 ? (
          <div
            className="rounded-xl p-10 text-center"
            style={{
              background: 'var(--bg-card, rgba(255,255,255,0.02))',
              border: '1px dashed rgba(255,255,255,0.10)',
            }}
          >
            <div
              className="mx-auto w-12 h-12 rounded-2xl flex items-center justify-center mb-3"
              style={{ background: 'rgba(255,255,255,0.04)' }}
            >
              <Globe size={22} style={{ color: 'var(--text-muted)' }} />
            </div>
            <div className="text-[13px] mb-1" style={{ color: 'var(--text-primary)' }}>
              还没有配对任何对端节点
            </div>
            <div className="text-[12px] max-w-md mx-auto leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              点击「添加对端」生成自己的连接串并发给对端，
              <br />
              任一端粘贴对端连接串并点击添加后，系统会完成双端确认。
            </div>
          </div>
        ) : (
          <div className="grid gap-2">
            {nodes.map((n) => (
              <article
                key={n.id}
                className="rounded-xl p-3.5 transition-colors"
                style={{
                  background: 'var(--bg-card, rgba(255,255,255,0.03))',
                  border: '1px solid rgba(255,255,255,0.08)',
                }}
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <div
                      className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center mt-0.5"
                      style={{
                        background:
                          n.status === 'connected'
                            ? 'rgba(34,197,94,0.10)'
                            : n.status === 'error'
                              ? 'rgba(239,68,68,0.10)'
                              : 'rgba(255,255,255,0.04)',
                        border: `1px solid ${
                          n.status === 'connected'
                            ? 'rgba(34,197,94,0.20)'
                            : n.status === 'error'
                              ? 'rgba(239,68,68,0.20)'
                              : 'rgba(255,255,255,0.08)'
                        }`,
                      }}
                    >
                      {n.status === 'connected' ? (
                        <CheckCircle2 size={16} style={{ color: 'rgba(34,197,94,0.95)' }} />
                      ) : n.status === 'error' ? (
                        <AlertCircle size={16} style={{ color: 'rgba(239,68,68,0.95)' }} />
                      ) : (
                        <Globe size={16} style={{ color: 'var(--text-muted)' }} />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                          {n.displayName}
                        </span>
                        <StatusDot status={n.status} />
                      </div>
                      <div
                        className="text-[11px] font-mono truncate mt-0.5"
                        style={{ color: 'var(--text-muted)' }}
                        title={n.baseUrl}
                      >
                        <ArrowRight size={9} className="inline mr-1" />
                        {n.baseUrl}
                      </div>
                      <div className="flex items-center gap-2 mt-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        <span>最近通信 {fmtRelative(n.lastContactAt)}</span>
                        {testProgress?.id === n.id && (
                          <span style={{ color: 'rgba(147,197,253,0.95)' }}>
                            · 测试中 {Math.round((Date.now() - testProgress.startedAt) / 1000)}s…
                          </span>
                        )}
                      </div>
                      {n.lastError && (
                        <div
                          className="mt-2 flex items-start gap-1.5 text-[11px] rounded-md px-2 py-1.5"
                          style={{
                            background: 'rgba(239,68,68,0.06)',
                            border: '1px solid rgba(239,68,68,0.16)',
                            color: 'rgba(252,165,165,0.95)',
                          }}
                        >
                          <AlertCircle size={11} className="shrink-0 mt-0.5" />
                          <span className="min-w-0 break-words">{n.lastError}</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button size="xs" variant="ghost" onClick={() => handleTest(n.id)} disabled={busyId === n.id}>
                      {busyId === n.id ? <MapSpinner size={12} /> : <Wifi size={12} />}
                      测试
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => handleDelete(n.id, n.displayName)}
                      disabled={busyId === n.id}
                      title="解除配对"
                    >
                      <Trash2 size={12} />
                    </Button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* ── Toast ── */}
      {toast && (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] rounded-lg px-4 py-2 text-[13px] shadow-lg flex items-center gap-2"
          style={{
            background: toast.kind === 'err' ? 'rgba(127,29,29,0.92)' : 'rgba(20,83,45,0.92)',
            color: '#fff',
            border: `1px solid ${toast.kind === 'err' ? 'rgba(239,68,68,0.40)' : 'rgba(34,197,94,0.40)'}`,
          }}
        >
          {toast.kind === 'err' ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />}
          <span>{toast.msg}</span>
          <button onClick={() => setToast(null)} className="opacity-60 hover:opacity-100 ml-1">
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
