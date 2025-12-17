import { Card } from '@/components/design/Card';

export default function LlmLabTab() {
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          大模型实验室
        </div>
        <div className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
          正在初始化：接下来会加入模型选择、内置测速/意图模板、TTFT 与总耗时对比、以及实验记录。
        </div>
      </Card>
    </div>
  );
}


