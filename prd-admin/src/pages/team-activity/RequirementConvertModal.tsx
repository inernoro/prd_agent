/**
 * 转需求弹窗（3 步向导）：VOC 闭环里「转需求」不再就地展开直接发送，而是走带步骤进度指示的多步弹窗，
 * 让用户对每一步有预期 —— ① 选产品 ② 核对内容 ③ 确认流转。确认后才调 insightToRequirement（逻辑在父组件）。
 * 产品列表复用 ExperienceDrill 同款 listProducts({page,pageSize}) 获取；单产品自动选中。
 * 遵守 .claude/rules/frontend-modal.md：createPortal + 布局尺寸 inline style + 滚动区 minHeight:0 +
 * overscrollBehavior contain + z-[100]+ + ESC/点遮罩关闭。
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronLeft, ChevronRight, ClipboardList, Package, X } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { listProducts } from '@/services/real/productAgent';
import type { Product } from '@/pages/product-agent/types';

export type RequirementConvertDraft = {
  title: string;
  description: string;
};

const STEPS = ['选产品', '核对内容', '确认流转'];

export function RequirementConvertModal({
  draft,
  submitting,
  onConfirm,
  onClose,
}: {
  /** 预填草稿（标题/描述），由父组件按当前洞察/下钻生成 */
  draft: RequirementConvertDraft;
  submitting?: boolean;
  /** 确认流转：父组件复用 insightToRequirement + reload */
  onConfirm: (productId: string, draft: RequirementConvertDraft) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const [products, setProducts] = useState<Product[] | null>(null);
  const [productsLoading, setProductsLoading] = useState(true);
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [title, setTitle] = useState(draft.title);
  const [description, setDescription] = useState(draft.description);

  // 进入即拉产品列表（与 ExperienceDrill 同款 listProducts）；单产品自动选中
  useEffect(() => {
    let alive = true;
    setProductsLoading(true);
    void listProducts({ page: 1, pageSize: 100 }).then((res) => {
      if (!alive) return;
      setProductsLoading(false);
      if (res.success) {
        const items = res.data.items ?? [];
        setProducts(items);
        if (items.length === 1) setSelectedProductId(items[0].id);
      } else {
        setProducts([]);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  // ESC 关闭（提交中不允许关）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  const selectedProduct = products?.find((p) => p.id === selectedProductId) ?? null;
  const noProduct = !productsLoading && (products?.length ?? 0) === 0;

  const canNextFromStep0 = !!selectedProductId;
  const canNextFromStep1 = title.trim().length > 0 && description.trim().length > 0;
  const canConfirm = !!selectedProductId && canNextFromStep1 && !submitting;

  const goNext = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));
  const goPrev = () => setStep((s) => Math.max(0, s - 1));

  const modal = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', padding: '4vh 4vw' }}
      onClick={() => !submitting && onClose()}
    >
      <div
        className="rounded-2xl border border-white/10 bg-[#16171b] flex flex-col w-full"
        style={{ maxWidth: 580, maxHeight: '88vh', boxShadow: '0 24px 80px rgba(0,0,0,0.6)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 + stepper */}
        <div className="px-5 pt-3.5 pb-3 border-b border-white/[0.06] shrink-0">
          <div className="flex items-center gap-2">
            <span className="w-7 h-7 rounded-md flex items-center justify-center" style={{ background: 'rgba(34,211,238,0.15)' }}>
              <ClipboardList size={15} className="text-cyan-300" />
            </span>
            <div className="flex flex-col">
              <span className="text-[14px] font-semibold text-white/90">转为产品需求</span>
              <span className="text-[11px] text-white/40">
                第 {step + 1} / {STEPS.length} 步：{STEPS[step]}
              </span>
            </div>
            <button
              type="button"
              onClick={() => !submitting && onClose()}
              title="关闭"
              className="ml-auto inline-flex items-center justify-center w-7 h-7 rounded-md text-white/40 hover:text-white/80 hover:bg-white/[0.06] transition-colors cursor-pointer"
            >
              <X size={16} />
            </button>
          </div>
          {/* stepper：圆点 + 连接线，当前/已完成高亮 */}
          <div className="flex items-center gap-1.5 mt-3">
            {STEPS.map((label, i) => {
              const done = i < step;
              const active = i === step;
              return (
                <div key={label} className="flex items-center gap-1.5 flex-1 last:flex-none">
                  <span
                    className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-semibold shrink-0 border transition-colors"
                    style={
                      done
                        ? { background: 'rgba(34,211,238,0.2)', borderColor: 'rgba(34,211,238,0.5)', color: '#67e8f9' }
                        : active
                          ? { background: 'rgba(34,211,238,0.15)', borderColor: '#22d3ee', color: '#a5f3fc' }
                          : { background: 'transparent', borderColor: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.35)' }
                    }
                  >
                    {done ? <Check size={11} /> : i + 1}
                  </span>
                  <span
                    className="text-[11px] shrink-0 transition-colors"
                    style={{ color: active ? '#a5f3fc' : done ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.35)' }}
                  >
                    {label}
                  </span>
                  {i < STEPS.length - 1 ? (
                    <span
                      className="flex-1 h-px transition-colors"
                      style={{ background: i < step ? 'rgba(34,211,238,0.4)' : 'rgba(255,255,255,0.1)' }}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        {/* 步骤内容滚动区 */}
        <div
          className="px-5 py-4 flex flex-col gap-3"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {/* Step 0：选产品 */}
          {step === 0 ? (
            <div className="flex flex-col gap-2">
              <span className="text-[12px] text-white/55 font-medium">选择落入哪个产品的需求池</span>
              {productsLoading ? (
                <div className="py-6 flex items-center justify-center">
                  <MapSpinner size={16} />
                </div>
              ) : noProduct ? (
                <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-3 text-[12px] text-amber-200/80 leading-relaxed">
                  还没有任何产品。请先在产品管理智能体创建产品，再回来流转需求。
                </div>
              ) : (
                <div className="flex flex-col gap-1.5" style={{ maxHeight: 280, overflowY: 'auto', overscrollBehavior: 'contain' }}>
                  {products!.map((p) => {
                    const active = selectedProductId === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setSelectedProductId(p.id)}
                        className={`flex items-center gap-2.5 px-3 h-11 rounded-lg text-left border transition-colors cursor-pointer ${
                          active
                            ? 'bg-cyan-500/12 border-cyan-500/40'
                            : 'bg-white/[0.03] border-white/10 hover:border-white/25'
                        }`}
                      >
                        <span
                          className="w-4 h-4 rounded-full shrink-0 border flex items-center justify-center"
                          style={{ borderColor: active ? '#22d3ee' : 'rgba(255,255,255,0.25)', background: active ? '#22d3ee' : 'transparent' }}
                        >
                          {active ? <Check size={11} className="text-[#0b1416]" /> : null}
                        </span>
                        <Package size={14} className="shrink-0 text-white/40" />
                        <span className={`truncate flex-1 text-[13px] ${active ? 'text-cyan-100' : 'text-white/80'}`}>{p.name}</span>
                        <span className="text-[11px] text-white/30 font-mono shrink-0">{p.productNo}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}

          {/* Step 1：核对内容 */}
          {step === 1 ? (
            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] text-white/55 font-medium">需求标题</span>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="h-9 px-3 rounded-lg text-[13px] text-white/90 bg-white/[0.04] border border-white/12 focus:border-cyan-400/60 outline-none transition-colors"
                  placeholder="一句话描述这个需求"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] text-white/55 font-medium">需求描述</span>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={9}
                  className="px-3 py-2.5 rounded-lg text-[12.5px] leading-relaxed text-white/85 font-mono bg-white/[0.04] border border-white/12 focus:border-cyan-400/60 outline-none transition-colors resize-y"
                  style={{ minHeight: 180 }}
                  placeholder="背景 / 证据 / 改进建议（已自动预填，可修改）"
                />
              </label>
            </div>
          ) : null}

          {/* Step 2：确认流转 */}
          {step === 2 ? (
            <div className="flex flex-col gap-3">
              <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-3 flex flex-col gap-2">
                <div className="flex items-center gap-2 text-[12px]">
                  <Package size={13} className="text-cyan-300/80 shrink-0" />
                  <span className="text-white/50">目标产品</span>
                  <span className="text-white/85 font-medium">{selectedProduct?.name ?? '—'}</span>
                  {selectedProduct?.productNo ? (
                    <span className="text-white/30 font-mono text-[11px]">{selectedProduct.productNo}</span>
                  ) : null}
                </div>
                <div className="flex items-start gap-2 text-[12px]">
                  <ClipboardList size={13} className="text-cyan-300/80 shrink-0 mt-0.5" />
                  <span className="text-white/50 shrink-0">需求标题</span>
                  <span className="text-white/85 break-words">{title.trim() || '—'}</span>
                </div>
              </div>
              <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/[0.05] px-3.5 py-2.5 text-[12px] text-cyan-100/80 leading-relaxed">
                确认后将创建到「{selectedProduct?.name ?? '所选产品'}」的需求池，进入需求池待评审。
              </div>
            </div>
          ) : null}
        </div>

        {/* 底部操作：上一步 / 下一步 / 确认 */}
        <div className="flex items-center justify-between gap-2 px-5 py-3.5 border-t border-white/[0.06] shrink-0">
          <button
            type="button"
            onClick={step === 0 ? () => !submitting && onClose() : goPrev}
            disabled={submitting}
            className="inline-flex items-center gap-1 px-3 h-9 rounded-lg text-[12px] border bg-white/[0.03] text-white/55 border-white/10 hover:text-white/85 hover:border-white/25 transition-colors cursor-pointer disabled:opacity-50"
          >
            {step === 0 ? '取消' : (<><ChevronLeft size={13} />上一步</>)}
          </button>
          {step < STEPS.length - 1 ? (
            <button
              type="button"
              disabled={step === 0 ? !canNextFromStep0 : !canNextFromStep1}
              onClick={goNext}
              style={(step === 0 ? !canNextFromStep0 : !canNextFromStep1) ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
              className="inline-flex items-center gap-1 px-3.5 h-9 rounded-lg text-[12px] border bg-cyan-500/18 text-cyan-100 border-cyan-500/35 hover:bg-cyan-500/28 transition-colors cursor-pointer"
            >
              下一步
              <ChevronRight size={13} />
            </button>
          ) : (
            <button
              type="button"
              disabled={!canConfirm}
              onClick={() => canConfirm && selectedProductId && onConfirm(selectedProductId, { title: title.trim(), description: description.trim() })}
              style={!canConfirm ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
              className="inline-flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-[12px] border bg-cyan-500/20 text-cyan-100 border-cyan-500/40 hover:bg-cyan-500/30 transition-colors cursor-pointer"
            >
              {submitting ? <MapSpinner size={13} /> : <ClipboardList size={13} />}
              {submitting ? '流转中…' : '确认流转'}
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
