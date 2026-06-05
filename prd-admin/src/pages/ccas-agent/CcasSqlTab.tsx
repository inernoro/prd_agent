import { useState } from 'react';
import { Braces, ListChecks, BookOpen, Sparkles } from 'lucide-react';
import { TabBar } from '@/components/design/TabBar';
import { CcasSqlInConverter } from './sql/CcasSqlInConverter';
import { CcasSqlDeduper } from './sql/CcasSqlDeduper';
import { CcasSqlSnippets } from './sql/CcasSqlSnippets';
import { CcasSqlAiAssistant } from './sql/CcasSqlAiAssistant';

type SqlSubTab = 'in' | 'dedup' | 'snippets' | 'ai';

interface SubTabDef {
  key: SqlSubTab;
  label: string;
  icon: React.ReactNode;
  render: () => React.ReactNode;
}

/**
 * SQL 助手 tab —— 服务 CCAS 业务的数据库辅助工具集。
 *
 * 当前包含两个子 tab：
 *   - IN 转化：把每行一个值拼成 SQL IN (...) 子句
 *   - 去重：按行去重，可选保持顺序 / 忽略大小写 / 去掉首尾空格
 *
 * 未来扩展指南：只要在 `SUB_TABS` 数组追加一项 `{ key, label, icon, render }` 即可，
 * 路由 / 权限 / 百宝箱 / 帮助抽屉 都不需要再改。
 */
const SUB_TABS: SubTabDef[] = [
  {
    key: 'in',
    label: 'IN 转化',
    icon: <Braces className="w-4 h-4" />,
    render: () => <CcasSqlInConverter />,
  },
  {
    key: 'dedup',
    label: '去重',
    icon: <ListChecks className="w-4 h-4" />,
    render: () => <CcasSqlDeduper />,
  },
  {
    key: 'snippets',
    label: '常用语句',
    icon: <BookOpen className="w-4 h-4" />,
    render: () => <CcasSqlSnippets />,
  },
  {
    key: 'ai',
    label: 'AI 助手',
    icon: <Sparkles className="w-4 h-4" />,
    render: () => <CcasSqlAiAssistant />,
  },
];

export function CcasSqlTab() {
  const [sub, setSub] = useState<SqlSubTab>('in');
  const active = SUB_TABS.find((t) => t.key === sub) ?? SUB_TABS[0];

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      <div className="shrink-0">
        <TabBar
          items={SUB_TABS.map((t) => ({ key: t.key, label: t.label, icon: t.icon }))}
          activeKey={sub}
          onChange={(k) => setSub(k as SqlSubTab)}
        />
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {active.render()}
      </div>
    </div>
  );
}
