import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PackageSearch, BookOpen, Stethoscope, GitCompare, ListChecks } from 'lucide-react';
import { KnowledgeTab } from './KnowledgeTab';
import { CasesTab } from './CasesTab';
import { DiffTab } from './DiffTab';
import { ChecklistTab } from './ChecklistTab';

type Tab = 'knowledge' | 'cases' | 'checklist' | 'diff';

function parseTab(value: string | null): Tab | null {
  return value === 'knowledge' || value === 'cases' || value === 'checklist' || value === 'diff' ? value : null;
}

export function ChannelTraceAgentPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => parseTab(searchParams.get('tab')) ?? 'knowledge');

  useEffect(() => {
    setTab(parseTab(searchParams.get('tab')) ?? 'knowledge');
  }, [searchParams]);

  const selectTab = (next: Tab) => {
    setTab(next);
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next === 'knowledge') {
          params.delete('tab');
        } else {
          params.set('tab', next);
        }
        return params;
      },
      { replace: true },
    );
  };

  return (
    <div className="h-full min-h-0 flex flex-col">
      <header className="shrink-0 border-b border-white/10 bg-white/3 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center">
            <PackageSearch className="w-5 h-5 text-emerald-400" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-semibold text-white">商品溯源智能体</h1>
            <p className="text-xs text-white/50 mt-0.5">
              面向防窜物流：业务知识快速问答、线上问题案例排查、业务规则与代码实现差异对比。
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1 mt-4">
          <TabButton active={tab === 'knowledge'} onClick={() => selectTab('knowledge')}>
            <span className="inline-flex items-center gap-1.5">
              <BookOpen className="w-3.5 h-3.5" />
              业务知识
            </span>
          </TabButton>
          <TabButton active={tab === 'cases'} onClick={() => selectTab('cases')}>
            <span className="inline-flex items-center gap-1.5">
              <Stethoscope className="w-3.5 h-3.5" />
              问题排查
            </span>
          </TabButton>
          <TabButton active={tab === 'checklist'} onClick={() => selectTab('checklist')}>
            <span className="inline-flex items-center gap-1.5">
              <ListChecks className="w-3.5 h-3.5" />
              排查清单
            </span>
          </TabButton>
          <TabButton active={tab === 'diff'} onClick={() => selectTab('diff')}>
            <span className="inline-flex items-center gap-1.5">
              <GitCompare className="w-3.5 h-3.5" />
              代码对比
            </span>
          </TabButton>
        </div>
      </header>

      {/* 四个 Tab 全部常驻挂载，仅用 display 切换可见性，保证切走再切回时
          对话记录 / 输入框 / 流式结果等组件状态不被卸载清空。 */}
      <div className="flex-1 min-h-0 relative">
        <div className={tab === 'knowledge' ? 'h-full min-h-0' : 'hidden'}>
          <KnowledgeTab />
        </div>
        <div className={tab === 'cases' ? 'h-full min-h-0' : 'hidden'}>
          <CasesTab />
        </div>
        <div className={tab === 'checklist' ? 'h-full min-h-0' : 'hidden'}>
          <ChecklistTab />
        </div>
        <div className={tab === 'diff' ? 'h-full min-h-0' : 'hidden'}>
          <DiffTab />
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3.5 py-1.5 rounded-lg text-sm transition-colors ${
        active
          ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
          : 'text-white/55 hover:text-white/80 hover:bg-white/5 border border-transparent'
      }`}
    >
      {children}
    </button>
  );
}
