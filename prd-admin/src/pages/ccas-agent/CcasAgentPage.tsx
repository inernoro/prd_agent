import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Factory, FileText, Image as ImageIcon, GitBranch, AlertCircle, MessageSquare, HelpCircle, X, Database, User } from 'lucide-react';
import { getCcasMeta } from '@/services';
import type { CcasMeta } from '@/services';
import { TabBar } from '@/components/design/TabBar';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { CcasPrdTab } from './CcasPrdTab';
import { CcasEquipmentTab } from './CcasEquipmentTab';
import { CcasFlowTab } from './CcasFlowTab';
import { CcasQaTab } from './CcasQaTab';
import { CcasSqlTab } from './CcasSqlTab';

type Tab = 'prd' | 'equipment' | 'flow' | 'qa' | 'sql';

const TABS: { key: Tab; label: string; icon: React.ReactNode; desc: string }[] = [
  { key: 'prd', label: 'PRD 文档生成', icon: <FileText className="w-4 h-4" />, desc: '按米多 product-document-generator 模板生成 / 优化产品文档（工程版 / 敏捷版）' },
  { key: 'equipment', label: '设备素材库', icon: <ImageIcon className="w-4 h-4" />, desc: '按预设风格生成产线设备图，攒一份属于你的素材库，给流程图节点用' },
  { key: 'flow', label: '流程示意图', icon: <GitBranch className="w-4 h-4" />, desc: 'AI 解析输入 → 节点 + 边 JSON → ReactFlow 拼装素材图，可拖动微调 + 导出' },
  { key: 'qa', label: '智能客服', icon: <MessageSquare className="w-4 h-4" />, desc: '基于知识库的严格 RAG 问答，知识库没有就明说不杜撰；可开联网开关补充模型公开知识' },
  { key: 'sql', label: 'SQL助手', icon: <Database className="w-4 h-4" />, desc: '服务 CCAS 业务的数据库 SQL 辅助工具集：IN 子句转换、列表去重等批量字符串处理；后续会继续扩展' },
];

export function CcasAgentPage() {
  const [tab, setTab] = useState<Tab>('prd');
  const [meta, setMeta] = useState<CcasMeta | null>(null);
  const [metaLoading, setMetaLoading] = useState(true);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setMetaLoading(true);
      const res = await getCcasMeta();
      if (cancelled) return;
      if (res.success && res.data) {
        setMeta(res.data);
        setMetaError(null);
      } else {
        setMetaError(res.error?.message || '元数据加载失败');
      }
      setMetaLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeTabDef = TABS.find((t) => t.key === tab) ?? TABS[0];

  return (
    <div className="h-full min-h-0 flex flex-col gap-4 px-6 py-5 overflow-hidden">
      {/* Header */}
      <header className="shrink-0 flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-amber-500/10 border border-amber-400/20 flex items-center justify-center">
          <Factory className="w-5 h-5 text-amber-300" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-white truncate">赋码采集关联系统智能体</h1>
          </div>
          <p className="text-xs text-white/50 truncate">{activeTabDef.desc}</p>
          {meta?.authorName && (
            <p className="text-[11px] text-white/35 mt-0.5 inline-flex items-center gap-1">
              <User className="w-3 h-3" />
              作者：{meta.authorName}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          className="shrink-0 h-8 px-3 rounded-lg border border-white/12 bg-white/5 hover:bg-white/10 text-xs text-white/75 inline-flex items-center gap-1.5 transition"
          title="查看使用说明和教程"
        >
          <HelpCircle className="w-3.5 h-3.5 text-amber-300/85" />
          使用帮助
        </button>
      </header>

      {/* Tabs */}
      <div className="shrink-0">
        <TabBar
          items={TABS.map((t) => ({ key: t.key, label: t.label, icon: t.icon }))}
          activeKey={tab}
          onChange={(k) => setTab(k as Tab)}
        />
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 flex flex-col">
        {metaLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <MapSectionLoader />
          </div>
        ) : metaError ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-sm text-red-300/80 flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              元数据加载失败：{metaError}
            </div>
          </div>
        ) : meta ? (
          <>
            {tab === 'prd' && <CcasPrdTab meta={meta} />}
            {tab === 'equipment' && <CcasEquipmentTab meta={meta} />}
            {tab === 'flow' && <CcasFlowTab meta={meta} />}
            {tab === 'qa' && <CcasQaTab meta={meta} />}
            {tab === 'sql' && <CcasSqlTab />}
          </>
        ) : null}
      </div>

      <CcasHelpDrawer open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

function CcasHelpDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const drawer = (
    <div
      className="fixed inset-0 z-[100] flex justify-end"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onClose}
    >
      <aside
        className="h-full border-l border-white/10 bg-[#0f1014] shadow-2xl flex flex-col"
        style={{ width: 'min(92vw, 520px)', maxHeight: '100vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="shrink-0 px-5 py-4 border-b border-white/10 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-white">赋码采集关联智能体使用帮助</h2>
            <p className="mt-1 text-xs text-white/45">从业务描述、知识库到 PRD、素材和流程图的一站式辅助。</p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/10 text-white/55">
            <X className="w-4 h-4" />
          </button>
        </header>

        <div
          className="flex-1 px-5 py-4 space-y-4 text-sm text-white/75"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          <section className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
            <h3 className="text-sm font-medium text-white mb-2">推荐使用路径</h3>
            <ol className="list-decimal list-inside space-y-1.5 text-white/65">
              <li>先在「知识库」上传项目背景、设备清单、接口规范、历史 PRD。</li>
              <li>回到本页面，在 PRD 文档生成或智能客服里点击「引用知识库」。</li>
              <li>需要完整上下文时选择「整库」，只想精确控制事实来源时选择单篇文档。</li>
              <li>先生成 PRD，再用流程示意图把瓶、箱、垛等节点关系画出来。</li>
            </ol>
          </section>

          <section className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
            <h3 className="text-sm font-medium text-white mb-2">五个功能区怎么用</h3>
            <div className="space-y-2 text-white/65">
              <p><span className="text-amber-200/90">PRD 文档生成：</span>把产品背景、产线设备、关联模式写清楚，AI 会按工程版或敏捷版模板输出；初稿生成后可用底部「改稿助手」多轮追问微调。</p>
              <p><span className="text-amber-200/90">设备素材库：</span>生成裹包机、工业相机、龙门架等设备图，后续可复用到流程图节点。</p>
              <p><span className="text-amber-200/90">流程示意图：</span>输入流程描述后解析为 ReactFlow 节点和边，可拖动调整并保存。</p>
              <p><span className="text-amber-200/90">智能客服：</span>默认严格基于知识库回答，知识库没有就说明没有；打开联网后允许补充模型公开知识。</p>
              <p><span className="text-amber-200/90">SQL 助手：</span>处理 CCAS 业务里反复出现的 SQL 片段——IN 子句拼接、列表去重，后续会继续加常用工具，全程纯前端不会回传数据。</p>
            </div>
          </section>

        </div>
      </aside>
    </div>
  );

  return createPortal(drawer, document.body);
}
