import { useState } from 'react';
import { ArrowLeft, CalendarCheck, ListChecks } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { TabBar } from '@/components/design/TabBar';
import { DailyLogPanel } from './DailyLogPanel';
import { MyRecordsListPanel } from './MyRecordsListPanel';

interface Props {
  onClose: () => void;
}

type SubTabKey = 'today' | 'records';

const SUB_TAB_ITEMS = [
  { key: 'today', label: '今日打点', icon: <CalendarCheck size={14} /> },
  { key: 'records', label: '我的记录', icon: <ListChecks size={14} /> },
];

/**
 * DailyLogInline — 日常记录入口，承载两个子菜单：
 * - 今日打点：当天 / 当周快速记录（DailyLogPanel）
 * - 我的记录：全部历史记录管理（按天分组、关键词搜索、时间筛选、分页）
 */
export function DailyLogInline({ onClose }: Props) {
  const [subTab, setSubTab] = useState<SubTabKey>('today');

  const backButton = (
    <Button variant="ghost" size="sm" onClick={onClose}>
      <ArrowLeft size={15} /> 返回周报
    </Button>
  );

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      <TabBar
        items={SUB_TAB_ITEMS}
        activeKey={subTab}
        onChange={(key) => setSubTab(key as SubTabKey)}
        actions={backButton}
      />
      <div className="flex-1 min-h-0">
        {subTab === 'today' && <DailyLogPanel />}
        {subTab === 'records' && <MyRecordsListPanel />}
      </div>
    </div>
  );
}
