/**
 * 产品管理 — 营销问策子模块（独立智能体，列表 → 详情 / compose 模型）。
 *
 * 顶部显眼介绍 banner（米多四力模型 4FM + 全域粉销理念）。
 * 默认进入「问策列表」：分页 + 搜索 + 筛选（客户/判定/模版）+「+问策」。
 * 点某条 → 详情：报告预览（可全屏）+ 分享/切模版/托管 + 聚合同一客户的其他问策。
 * 「+问策」→ compose：自由文本输入客户情况，可选「一键问策已有客户」，流式生成后进详情。
 * 不强制选客户：自由文本即可问策。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Sparkles, Square, X, Cpu, Share2, Link as LinkIcon, Globe, Search,
  Download, Maximize2, Minimize2, Palette, ExternalLink, Plus, FileText, ArrowLeft,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming/StreamingText';
import { connectSse } from '@/lib/useSseStream';
import { toast } from '@/lib/toast';
import {
  MARKETING_TEMPLATES,
  listAllConsultReports,
  listConsultReports,
  listCustomers,
  getConsultReport,
  restyleConsultReport,
  shareConsultReport,
  saveConsultToHosting,
  consultGenerateUrl,
  consultSharedUrl,
} from '@/services/real/productAgent';
import type { Customer, MarketingConsultListItem, MarketingConsultReport, MarketingTemplate, MarketingVerdict } from './types';

const VERDICT_META: Record<MarketingVerdict, { label: string; cls: string }> = {
  healthy: { label: '健康', cls: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300' },
  watch: { label: '关注', cls: 'border-amber-400/25 bg-amber-400/10 text-amber-200' },
  risk: { label: '风险', cls: 'border-rose-400/25 bg-rose-400/10 text-rose-300' },
};
const VERDICT_OPTIONS: { value: MarketingVerdict; label: string }[] = [
  { value: 'healthy', label: '健康' }, { value: 'watch', label: '关注' }, { value: 'risk', label: '风险' },
];
const PAGE_SIZE = 20;

function downloadHtml(title: string, html: string) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${title}.html`; a.click();
  URL.revokeObjectURL(url);
}
function fmtTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
const templateLabel = (k: MarketingTemplate) => MARKETING_TEMPLATES.find((t) => t.key === k)?.label ?? k;

type View = 'list' | 'compose' | 'detail';

export function MarketingConsultModule({ initialCustomerId }: { initialCustomerId: string | null }) {
  const [view, setView] = useState<View>(initialCustomerId ? 'compose' : 'list');
  const [customers, setCustomers] = useState<Customer[]>([]);

  // 列表态
  const [reports, setReports] = useState<MarketingConsultListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loadingList, setLoadingList] = useState(true);
  const [kw, setKw] = useState('');
  const [appliedKw, setAppliedKw] = useState('');
  const [fCustomer, setFCustomer] = useState('');
  const [fVerdict, setFVerdict] = useState('');
  const [fTemplate, setFTemplate] = useState('');

  // 详情态
  const [viewing, setViewing] = useState<MarketingConsultReport | null>(null);
  const [sameCustomer, setSameCustomer] = useState<MarketingConsultListItem[]>([]);
  const [openingId, setOpeningId] = useState<string | null>(null);

  // compose 态
  const [pickCustomerId, setPickCustomerId] = useState<string>(initialCustomerId ?? '');

  const loadList = useCallback(async () => {
    setLoadingList(true);
    const res = await listAllConsultReports({ page, pageSize: PAGE_SIZE, keyword: appliedKw || undefined, customerId: fCustomer || undefined, verdict: fVerdict || undefined, template: fTemplate || undefined });
    if (res.success) { setReports(res.data.items); setTotal(res.data.total); }
    setLoadingList(false);
  }, [page, appliedKw, fCustomer, fVerdict, fTemplate]);
  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => {
    void listCustomers({}).then((res) => { if (res.success) setCustomers(res.data.items); });
  }, []);
  useEffect(() => {
    if (initialCustomerId) { setPickCustomerId(initialCustomerId); setView('compose'); }
  }, [initialCustomerId]);

  const openReport = async (id: string) => {
    setOpeningId(id);
    const res = await getConsultReport(id);
    setOpeningId(null);
    if (!res.success) { toast.error('加载失败', res.error?.message); return; }
    setViewing(res.data);
    setView('detail');
    if (res.data.customerId) {
      const sc = await listConsultReports(res.data.customerId);
      if (sc.success) setSameCustomer(sc.data.items);
    } else setSameCustomer([]);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-4">
      <ConsultBanner />

      {view === 'list' && (
        <ConsultListView
          reports={reports} total={total} loading={loadingList}
          page={page} totalPages={totalPages} onPage={setPage}
          kw={kw} setKw={setKw} onSearch={() => { setPage(1); setAppliedKw(kw.trim()); }}
          customers={customers}
          fCustomer={fCustomer} setFCustomer={(v) => { setPage(1); setFCustomer(v); }}
          fVerdict={fVerdict} setFVerdict={(v) => { setPage(1); setFVerdict(v); }}
          fTemplate={fTemplate} setFTemplate={(v) => { setPage(1); setFTemplate(v); }}
          openingId={openingId} onOpen={openReport}
          onNew={() => { setPickCustomerId(''); setView('compose'); }}
        />
      )}

      {view === 'compose' && (
        <ComposeView
          customers={customers}
          initialCustomerId={pickCustomerId}
          onCancel={() => setView('list')}
          onDone={(report) => { setViewing(report); setSameCustomer([]); setView('detail'); void loadList(); if (report.customerId) void listConsultReports(report.customerId).then((r) => { if (r.success) setSameCustomer(r.data.items); }); }}
        />
      )}

      {view === 'detail' && viewing && (
        <ConsultDetailView
          report={viewing}
          sameCustomer={sameCustomer}
          onOpen={openReport}
          onBack={() => { setViewing(null); setView('list'); void loadList(); }}
          onChanged={loadList}
          onNew={() => { setPickCustomerId(''); setView('compose'); }}
        />
      )}
    </div>
  );
}

function ConsultBanner() {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-cyan-500/25 bg-gradient-to-br from-cyan-500/[0.12] to-transparent p-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-400/30 bg-cyan-500/15">
        <Sparkles size={20} className="text-cyan-300" />
      </div>
      <div className="min-w-0">
        <div className="text-base font-semibold text-white">营销问策智能体</div>
        <div className="mt-0.5 text-xs leading-5 text-white/55">
          基于<span className="text-cyan-200/90">米多四力模型（4FM：产品力 · 渠道力 · 场景力 · 传播力）</span>与<span className="text-cyan-200/90">全域粉销</span>理念，为商户/客户做专业营销评估，并一键生成可分享的可视化报告。
        </div>
      </div>
    </div>
  );
}

// ════════════════════════ 列表 ════════════════════════

function ConsultListView({
  reports, total, loading, page, totalPages, onPage,
  kw, setKw, onSearch, customers,
  fCustomer, setFCustomer, fVerdict, setFVerdict, fTemplate, setFTemplate,
  openingId, onOpen, onNew,
}: {
  reports: MarketingConsultListItem[]; total: number; loading: boolean;
  page: number; totalPages: number; onPage: (p: number) => void;
  kw: string; setKw: (v: string) => void; onSearch: () => void; customers: Customer[];
  fCustomer: string; setFCustomer: (v: string) => void;
  fVerdict: string; setFVerdict: (v: string) => void;
  fTemplate: string; setFTemplate: (v: string) => void;
  openingId: string | null; onOpen: (id: string) => void; onNew: () => void;
}) {
  const selCls = 'rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white/70 outline-none focus:border-cyan-500/40';
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5">
          <Search size={14} className="text-white/40" />
          <input
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onSearch(); }}
            placeholder="搜索标题 / 客户"
            className="w-44 bg-transparent text-sm text-white outline-none"
          />
        </div>
        <select value={fCustomer} onChange={(e) => setFCustomer(e.target.value)} className={selCls}>
          <option value="">全部客户</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={fVerdict} onChange={(e) => setFVerdict(e.target.value)} className={selCls}>
          <option value="">全部判定</option>
          {VERDICT_OPTIONS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
        </select>
        <select value={fTemplate} onChange={(e) => setFTemplate(e.target.value)} className={selCls}>
          <option value="">全部模版</option>
          {MARKETING_TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <button onClick={onNew} className="ml-auto flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/20 px-3 py-1.5 text-sm text-cyan-200 hover:bg-cyan-500/30">
          <Plus size={14} /> 问策
        </button>
      </div>

      {loading ? (
        <MapSectionLoader text="正在加载问策…" />
      ) : reports.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 py-12 text-center text-sm text-white/40">
          没有问策记录。点右上角「问策」开始第一份营销评估。
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border border-white/10">
            <table className="w-full text-left text-sm">
              <thead className="bg-white/[0.03] text-xs text-white/45">
                <tr>
                  <th className="px-4 py-2.5 font-medium">标题</th>
                  <th className="px-4 py-2.5 font-medium">客户</th>
                  <th className="px-4 py-2.5 font-medium">判定</th>
                  <th className="px-4 py-2.5 font-medium">模版</th>
                  <th className="px-4 py-2.5 font-medium">创建时间</th>
                  <th className="px-4 py-2.5 font-medium">状态</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.id} onClick={() => onOpen(r.id)} className="cursor-pointer border-t border-white/5 hover:bg-white/[0.03]">
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1.5 text-white/90">
                        <FileText size={13} className="shrink-0 text-white/35" />
                        <span className="truncate">{r.title}</span>
                        {openingId === r.id && <MapSpinner size={12} />}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-white/60">{r.customerName || <span className="text-white/35">自由问策</span>}</td>
                    <td className="px-4 py-3">{r.verdict ? <span className={`rounded-full border px-2 py-0.5 text-[11px] ${VERDICT_META[r.verdict].cls}`}>{VERDICT_META[r.verdict].label}</span> : <span className="text-white/30">-</span>}</td>
                    <td className="px-4 py-3 text-xs text-white/55">{templateLabel(r.template)}</td>
                    <td className="px-4 py-3 text-xs text-white/45">{fmtTime(r.createdAt)}</td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2 text-white/45">
                        {r.shared && <span className="flex items-center gap-1 text-emerald-300/80"><Share2 size={12} /></span>}
                        {r.hostedSiteUrl && <span className="flex items-center gap-1 text-cyan-300/80"><Globe size={12} /></span>}
                        {!r.shared && !r.hostedSiteUrl && <span className="text-white/25">-</span>}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-xs text-white/45">
            <span>共 {total} 条</span>
            <div className="flex items-center gap-2">
              <button disabled={page <= 1} onClick={() => onPage(page - 1)} className="flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 disabled:opacity-30 hover:bg-white/5"><ChevronLeft size={13} /> 上一页</button>
              <span>{page} / {totalPages}</span>
              <button disabled={page >= totalPages} onClick={() => onPage(page + 1)} className="flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 disabled:opacity-30 hover:bg-white/5">下一页 <ChevronRight size={13} /></button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ════════════════════════ 新问策 compose ════════════════════════

function ComposeView({
  customers, initialCustomerId, onCancel, onDone,
}: {
  customers: Customer[];
  initialCustomerId: string;
  onCancel: () => void;
  onDone: (report: MarketingConsultReport) => void;
}) {
  const [input, setInput] = useState('');
  const [note, setNote] = useState('');
  const [template, setTemplate] = useState<MarketingTemplate>('exec');
  const [pickCustomerId, setPickCustomerId] = useState(initialCustomerId);
  const [phase, setPhase] = useState<'idle' | 'streaming' | 'failed'>('idle');
  const [stageMsg, setStageMsg] = useState('');
  const [model, setModel] = useState('');
  const [thinking, setThinking] = useState('');
  const [content, setContent] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const streaming = phase === 'streaming';

  const generate = async () => {
    if (!pickCustomerId && !input.trim()) { toast.error('请输入客户情况，或选择一个已有客户'); return; }
    setPhase('streaming'); setStageMsg('连接中…'); setModel(''); setThinking(''); setContent('');
    const controller = new AbortController();
    abortRef.current = controller;
    let reportId = '';
    let failed: string | null = null;
    try {
      await connectSse({
        url: consultGenerateUrl(),
        method: 'POST',
        body: { customerId: pickCustomerId || undefined, input: input.trim() || undefined, note: note.trim() || undefined, template },
        signal: controller.signal,
        onEvent: (evt) => {
          if (!evt.data) return;
          try {
            const data = JSON.parse(evt.data) as Record<string, string | undefined>;
            if (evt.event === 'stage') setStageMsg(data.message || '');
            else if (evt.event === 'model') setModel(data.model || '');
            else if (evt.event === 'thinking') setThinking((p) => p + (data.text || ''));
            else if (evt.event === 'typing') setContent((p) => p + (data.text || ''));
            else if (evt.event === 'error') failed = data.message || '生成失败';
            else if (evt.event === 'done' && data.reportId) reportId = data.reportId;
          } catch { /* ignore */ }
        },
      });
    } catch { /* aborted / network */ }
    abortRef.current = null;
    if (reportId) {
      const res = await getConsultReport(reportId);
      if (res.success) { onDone(res.data); return; }
      failed = res.error?.message || '报告加载失败';
    }
    if (failed) toast.error('生成失败', failed);
    setPhase('failed');
  };

  return (
    <div className="flex flex-col gap-3">
      <button onClick={onCancel} className="flex items-center gap-1 self-start text-xs text-white/45 hover:text-white"><ArrowLeft size={13} /> 返回问策列表</button>
      <div className="flex max-w-3xl flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-white/80">新的营销问策</span>
          {model && <span className="ml-1 flex items-center gap-1 font-mono text-[11px] text-white/40"><Cpu size={11} />{model}</span>}
        </div>
        <textarea
          value={input} onChange={(e) => setInput(e.target.value)} rows={5} disabled={streaming}
          placeholder="输入客户情况：经营阶段、所在行业/区域、近期动作、遇到的问题、想解决的营销诉求等。也可在下方选择一个已有客户做「一键问策」（自动带入其全部信息与动态跟进）。"
          className="resize-none rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-500/40 placeholder:text-white/25 disabled:opacity-50"
        />
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-white/45">一键问策已有客户（可选）：</span>
          <select value={pickCustomerId} onChange={(e) => setPickCustomerId(e.target.value)} disabled={streaming}
            className="min-w-[180px] rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white outline-none focus:border-cyan-500/40 disabled:opacity-50">
            <option value="">不绑定客户（用上方自由文本）</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.merchantNo ? `（${c.merchantNo}）` : ''}</option>)}
          </select>
        </div>
        <input value={note} onChange={(e) => setNote(e.target.value)} disabled={streaming}
          placeholder="（可选）补充要求：如更侧重渠道力 / 给管理层看 / 语气更正式"
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/40 placeholder:text-white/25 disabled:opacity-50" />
        <div>
          <div className="mb-1.5 text-xs text-white/50">报告模版</div>
          <TemplatePicker value={template} onChange={setTemplate} disabled={streaming} />
        </div>
        {streaming ? (
          <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-black/20 p-3">
            <div className="flex items-center gap-2 text-xs text-cyan-300"><MapSpinner size={14} /> {stageMsg}</div>
            {thinking && <div className="max-h-40 overflow-y-auto rounded-md bg-white/[0.03] px-2.5 py-1.5 text-xs text-white/45"><StreamingText text={thinking} streaming mode="blur" /></div>}
            {content && <div className="rounded-md bg-white/[0.03] px-2.5 py-1.5 font-mono text-xs text-white/60"><StreamingText text={content} streaming mode="blur" /></div>}
            <div className="flex justify-end">
              <button onClick={() => { abortRef.current?.abort(); setPhase('idle'); }} className="flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-sm text-white/60 hover:bg-white/5"><Square size={13} /> 停止</button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button onClick={generate} className="flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/20 px-4 py-2 text-sm text-cyan-200 hover:bg-cyan-500/30">
              <Sparkles size={14} /> {pickCustomerId && !input.trim() ? '一键问策' : '生成问策评估'}
            </button>
            {phase === 'failed' && <span className="text-xs text-rose-300/80">上次生成未完成，可重试。</span>}
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════ 详情（报告 + 同客户聚合） ════════════════════════

function ConsultDetailView({
  report, sameCustomer, onOpen, onBack, onChanged, onNew,
}: {
  report: MarketingConsultReport;
  sameCustomer: MarketingConsultListItem[];
  onOpen: (id: string) => void;
  onBack: () => void;
  onChanged: () => void;
  onNew: () => void;
}) {
  const others = sameCustomer.filter((s) => s.id !== report.id);
  const hasCustomer = !!report.customerId && sameCustomer.length > 0;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="flex items-center gap-1 text-xs text-white/45 hover:text-white"><ArrowLeft size={13} /> 返回问策列表</button>
        <button onClick={onNew} className="ml-auto flex items-center gap-1.5 rounded-md border border-cyan-500/30 bg-cyan-500/15 px-3 py-1.5 text-xs text-cyan-200 hover:bg-cyan-500/25"><Plus size={13} /> 新问策</button>
      </div>
      <div className="flex gap-4">
        <div className="min-w-0 flex-1">
          <ConsultReportView report={report} onChanged={onChanged} />
        </div>
        {hasCustomer && (
          <div className="w-56 shrink-0">
            <div className="mb-2 text-xs font-medium text-white/55">同一客户的问策（{sameCustomer.length}）</div>
            <div className="divide-y divide-white/5 overflow-hidden rounded-xl border border-white/10">
              {others.length === 0 ? (
                <div className="px-3 py-4 text-center text-[11px] text-white/35">该客户暂无其他问策</div>
              ) : others.map((s) => (
                <button key={s.id} onClick={() => onOpen(s.id)} className="flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-white/[0.03]">
                  <span className="truncate text-[12px] text-white/80">{s.title}</span>
                  <span className="flex items-center gap-1.5 text-[10px] text-white/40">
                    {fmtTime(s.createdAt)}
                    {s.verdict && <span className={`rounded-full border px-1 py-px ${VERDICT_META[s.verdict].cls}`}>{VERDICT_META[s.verdict].label}</span>}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TemplatePicker({ value, onChange, disabled }: { value: MarketingTemplate; onChange: (k: MarketingTemplate) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {MARKETING_TEMPLATES.map((t) => {
        const on = t.key === value;
        return (
          <button key={t.key} onClick={() => onChange(t.key)} disabled={disabled} title={t.desc}
            className={`rounded-lg border px-3 py-1.5 text-xs disabled:opacity-50 ${on ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200' : 'border-white/10 text-white/55 hover:bg-white/5'}`}>
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ── 报告预览（内联 + 可全屏） ──

function ConsultReportView({ report, onChanged }: { report: MarketingConsultReport; onChanged: () => void }) {
  const [r, setR] = useState(report);
  const [sharing, setSharing] = useState(false);
  const [hosting, setHosting] = useState(false);
  const [restyling, setRestyling] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => { setR(report); }, [report]);

  const shareUrl = r.shareToken ? `${window.location.origin}${consultSharedUrl(r.shareToken)}` : '';
  const copyShare = async (url: string) => {
    try { await navigator.clipboard.writeText(url); toast.success('分享链接已复制', '匿名可直接打开，撤销分享后失效'); }
    catch { toast.error('复制失败', url); }
  };
  const toggleShare = async (enabled: boolean) => {
    setSharing(true);
    const res = await shareConsultReport(r.id, enabled);
    setSharing(false);
    if (!res.success) { toast.error('操作失败', res.error?.message); return; }
    setR((p) => ({ ...p, shared: res.data.shared, shareToken: res.data.shareToken }));
    onChanged();
    if (res.data.shared && res.data.shareToken) await copyShare(`${window.location.origin}${consultSharedUrl(res.data.shareToken)}`);
    else if (!res.data.shared) toast.success('已撤销分享', '原链接立即失效');
  };
  const saveHosting = async () => {
    setHosting(true);
    const res = await saveConsultToHosting(r.id);
    setHosting(false);
    if (!res.success) { toast.error('保存到网页托管失败', res.error?.message); return; }
    setR((p) => ({ ...p, hostedSiteId: res.data.siteId, hostedSiteUrl: res.data.siteUrl }));
    onChanged();
    toast.success('已保存到网页托管', '点击「打开托管站点」即可访问');
  };
  const restyle = async (key: MarketingTemplate) => {
    setPickerOpen(false);
    if (key === r.template) return;
    setRestyling(true);
    const res = await restyleConsultReport(r.id, key);
    setRestyling(false);
    if (!res.success) { toast.error('切换模版失败', res.error?.message); return; }
    setR((p) => ({ ...p, template: res.data.template, html: res.data.html }));
    onChanged();
    toast.success('模版已切换', templateLabel(key));
  };

  const toolbar = (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-white/10 px-3 py-2.5">
      <span className="max-w-[260px] truncate text-sm font-semibold text-white">{r.title}</span>
      {r.model && <span className="font-mono text-[11px] text-white/40">{r.model}</span>}
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        {r.canRestyle && <ToolBtn onClick={() => setPickerOpen((v) => !v)} disabled={restyling}>{restyling ? <MapSpinner size={12} /> : <Palette size={12} />} 模版：{templateLabel(r.template)}</ToolBtn>}
        {r.shared ? (
          <>
            <ToolBtn onClick={() => copyShare(shareUrl)}><LinkIcon size={12} /> 复制链接</ToolBtn>
            <ToolBtn onClick={() => toggleShare(false)} disabled={sharing}>{sharing ? <MapSpinner size={12} /> : <X size={12} />} 撤销分享</ToolBtn>
          </>
        ) : (
          <ToolBtn onClick={() => toggleShare(true)} disabled={sharing}>{sharing ? <MapSpinner size={12} /> : <Share2 size={12} />} 开启分享</ToolBtn>
        )}
        {r.hostedSiteUrl ? (
          <ToolBtn onClick={() => window.open(r.hostedSiteUrl!, '_blank', 'noopener')}><ExternalLink size={12} /> 打开托管站点</ToolBtn>
        ) : (
          <ToolBtn onClick={saveHosting} disabled={hosting}>{hosting ? <MapSpinner size={12} /> : <Globe size={12} />} 保存到网页托管</ToolBtn>
        )}
        <ToolBtn onClick={() => r.html && downloadHtml(r.title, r.html)}><Download size={12} /> 下载 HTML</ToolBtn>
        <ToolBtn onClick={() => setFullscreen((v) => !v)}>{fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />} {fullscreen ? '退出全屏' : '全屏'}</ToolBtn>
      </div>
    </div>
  );
  const stylePickerBar = pickerOpen && r.canRestyle && (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-white/10 bg-black/20 px-3 py-2.5">
      <span className="text-[11px] text-white/45">切换模版（即时重渲染，不重新调用 AI）：</span>
      <TemplatePicker value={r.template} onChange={restyle} disabled={restyling} />
    </div>
  );

  if (fullscreen) {
    return createPortal(
      <div className="fixed inset-0 z-[10000] flex flex-col bg-[#16181d]">
        {toolbar}{stylePickerBar}
        <div className="min-h-0 flex-1 bg-[#f3f4f6]"><iframe title={r.title} srcDoc={r.html || ''} sandbox="" style={{ width: '100%', height: '100%', border: 0, display: 'block' }} /></div>
      </div>, document.body,
    );
  }
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-white/10 bg-[#16181d]">
      {toolbar}{stylePickerBar}
      <div className="bg-[#f3f4f6]" style={{ height: '72vh' }}><iframe title={r.title} srcDoc={r.html || ''} sandbox="" style={{ width: '100%', height: '100%', border: 0, display: 'block' }} /></div>
    </div>
  );
}

function ToolBtn({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} className="flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[11px] text-white/60 hover:bg-white/5 disabled:opacity-40">
      {children}
    </button>
  );
}
