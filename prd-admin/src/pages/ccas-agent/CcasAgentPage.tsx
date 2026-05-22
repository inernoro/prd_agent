import { useEffect, useState } from 'react';
import { Factory, FileText, Image as ImageIcon, GitBranch, AlertCircle } from 'lucide-react';
import { getCcasMeta } from '@/services';
import type { CcasMeta } from '@/services';
import { TabBar } from '@/components/design/TabBar';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { CcasPrdTab } from './CcasPrdTab';
import { CcasEquipmentTab } from './CcasEquipmentTab';
import { CcasFlowTab } from './CcasFlowTab';

type Tab = 'prd' | 'equipment' | 'flow';

const TABS: { key: Tab; label: string; icon: React.ReactNode; desc: string }[] = [
  { key: 'prd', label: 'PRD 文档生成', icon: <FileText className="w-4 h-4" />, desc: '按米多 product-document-generator 模板生成 / 优化产品文档（工程版 / 敏捷版）' },
  { key: 'equipment', label: '设备素材库', icon: <ImageIcon className="w-4 h-4" />, desc: '按预设风格生成产线设备图，攒一份属于你的素材库，给流程图节点用' },
  { key: 'flow', label: '流程示意图', icon: <GitBranch className="w-4 h-4" />, desc: 'AI 解析输入 → 节点 + 边 JSON → ReactFlow 拼装素材图，可拖动微调 + 导出' },
];

export function CcasAgentPage() {
  const [tab, setTab] = useState<Tab>('prd');
  const [meta, setMeta] = useState<CcasMeta | null>(null);
  const [metaLoading, setMetaLoading] = useState(true);
  const [metaError, setMetaError] = useState<string | null>(null);

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
            <span className="px-1.5 py-0.5 rounded text-[10px] bg-orange-500/15 text-orange-300 border border-orange-400/30">
              施工中
            </span>
          </div>
          <p className="text-xs text-white/50 truncate">{activeTabDef.desc}</p>
        </div>
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
          </>
        ) : null}
      </div>
    </div>
  );
}
