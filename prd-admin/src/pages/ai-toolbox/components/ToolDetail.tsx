import { useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { useToolboxStore } from '@/stores/toolboxStore';
import { ArrowLeft, Play, Edit, Trash2, Zap, Tag, Calendar, User } from 'lucide-react';
import { formatDistanceToNow } from '@/lib/dateUtils';

export function ToolDetail() {
  const { selectedItem, backToGrid, startEdit, deleteItem, runItem } = useToolboxStore();
  const [input, setInput] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  if (!selectedItem) return null;

  const handleRun = () => {
    if (!input.trim()) return;
    runItem(selectedItem.id, input.trim());
  };

  const handleDelete = async () => {
    if (!confirm('确定要删除这个工具吗？')) return;
    setIsDeleting(true);
    await deleteItem(selectedItem.id);
    setIsDeleting(false);
  };

  const isCustom = selectedItem.type === 'custom';

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      {/* Header */}
      <TabBar
        title={selectedItem.name}
        icon={<span className="text-lg">{selectedItem.icon}</span>}
        items={[]}
        activeKey=""
        onChange={() => {}}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={backToGrid}>
              <ArrowLeft size={14} />
              返回
            </Button>
            {isCustom && (
              <>
                <Button variant="secondary" size="sm" onClick={() => startEdit(selectedItem)}>
                  <Edit size={14} />
                  编辑
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleDelete}
                  disabled={isDeleting}
                  style={{ color: 'var(--status-error)' }}
                >
                  <Trash2 size={14} />
                  删除
                </Button>
              </>
            )}
          </div>
        }
      />

      <div className="flex-1 min-h-0 flex gap-4">
        {/* Left: Info */}
        <div className="w-80 flex-shrink-0 flex flex-col gap-4">
          <GlassCard className="p-4">
            {/* Icon & Name */}
            <div className="flex items-center gap-3 mb-4">
              <div
                className="w-16 h-16 rounded-xl flex items-center justify-center text-3xl"
                style={{ background: 'var(--bg-base)' }}
              >
                {selectedItem.icon}
              </div>
              <div>
                <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                  {selectedItem.name}
                </div>
                <span
                  className="text-xs px-2 py-0.5 rounded-full"
                  style={{
                    background: selectedItem.type === 'builtin' ? 'var(--accent-primary)/10' : 'var(--status-success)/10',
                    color: selectedItem.type === 'builtin' ? 'var(--accent-primary)' : 'var(--status-success)',
                  }}
                >
                  {selectedItem.type === 'builtin' ? '内置工具' : '自定义'}
                </span>
              </div>
            </div>

            {/* Description */}
            <div className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
              {selectedItem.description}
            </div>

            {/* Meta */}
            <div className="space-y-2 text-xs" style={{ color: 'var(--text-muted)' }}>
              {selectedItem.usageCount > 0 && (
                <div className="flex items-center gap-2">
                  <Zap size={12} />
                  <span>已使用 {selectedItem.usageCount} 次</span>
                </div>
              )}
              {selectedItem.createdByName && (
                <div className="flex items-center gap-2">
                  <User size={12} />
                  <span>创建者: {selectedItem.createdByName}</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <Calendar size={12} />
                <span>创建于 {formatDistanceToNow(new Date(selectedItem.createdAt))}</span>
              </div>
            </div>

            {/* Tags */}
            {selectedItem.tags.length > 0 && (
              <div className="mt-4">
                <div className="flex items-center gap-1 text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
                  <Tag size={12} />
                  标签
                </div>
                <div className="flex flex-wrap gap-1">
                  {selectedItem.tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-xs px-2 py-0.5 rounded"
                      style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)' }}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </GlassCard>

          {/* Agent Key (for builtin) */}
          {selectedItem.agentKey && (
            <GlassCard className="p-4">
              <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
                关联 Agent
              </div>
              <code
                className="text-sm px-2 py-1 rounded"
                style={{ background: 'var(--bg-base)', color: 'var(--accent-primary)' }}
              >
                {selectedItem.agentKey}
              </code>
            </GlassCard>
          )}
        </div>

        {/* Right: Input & Run */}
        <div className="flex-1 min-w-0 flex flex-col gap-4">
          <GlassCard className="flex-1 p-4 flex flex-col">
            <div className="text-sm font-medium mb-3" style={{ color: 'var(--text-primary)' }}>
              开始使用
            </div>

            {/* Input area */}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={getPlaceholder(selectedItem.agentKey)}
              className="flex-1 min-h-[200px] p-3 rounded-lg border text-sm resize-none outline-none"
              style={{
                background: 'var(--bg-base)',
                borderColor: 'var(--border-default)',
                color: 'var(--text-primary)',
              }}
            />

            {/* Run button */}
            <div className="flex justify-end mt-4">
              <Button
                variant="primary"
                onClick={handleRun}
                disabled={!input.trim()}
              >
                <Play size={16} />
                运行
              </Button>
            </div>
          </GlassCard>
        </div>
      </div>
    </div>
  );
}

function getPlaceholder(agentKey?: string): string {
  switch (agentKey) {
    case 'prd-agent':
      return '粘贴你的 PRD 内容，或输入关于需求的问题...';
    case 'visual-agent':
      return '描述你想要生成的图片，例如：一只可爱的橘猫在阳光下打盹...';
    case 'literary-agent':
      return '输入你想要创作的内容主题，例如：写一篇关于春天的散文...';
    case 'defect-agent':
      return '描述你发现的 Bug，包括复现步骤和预期行为...';
    case 'code-reviewer':
      return '粘贴需要审查的代码...';
    case 'translator':
      return '输入需要翻译的内容，支持自动检测语言...';
    case 'summarizer':
      return '粘贴需要摘要的长文本...';
    case 'data-analyst':
      return '描述你的数据分析需求，或粘贴数据...';
    default:
      return '输入你的请求...';
  }
}
