import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { TranscriptSidebar } from '@/components/transcript/TranscriptSidebar';
import { TranscriptEditor } from '@/components/transcript/TranscriptEditor';
import { GenerateDialog } from '@/components/transcript/GenerateDialog';
import { GlassCard } from '@/components/design/GlassCard';
import type { TranscriptItem } from '@/services/contracts/transcriptAgent';

export default function TranscriptAgentPage() {
  const { items, templates, refreshItems, fetchTemplates } = useTranscriptStore();
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [generateItem, setGenerateItem] = useState<TranscriptItem | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  // Derive selectedItem from store (single source of truth)
  const selectedItem = useMemo(
    () => items.find(i => i.id === selectedItemId) ?? null,
    [items, selectedItemId],
  );

  useEffect(() => { fetchTemplates(); }, []);

  // Auto-poll pending/processing items — use ref to avoid dep on items
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => {
    const timer = setInterval(() => {
      const pending = itemsRef.current.filter(
        i => i.transcribeStatus === 'pending' || i.transcribeStatus === 'processing',
      );
      if (pending.length > 0) refreshItems();
    }, 3000);
    return () => clearInterval(timer);
  }, [refreshItems]);

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      <div className="grid gap-4 flex-1 min-h-0 lg:grid-cols-[280px_1fr]">
        {/* 左侧：工作区+素材列表 */}
        <GlassCard animated glow className="flex flex-col min-h-0 p-0 overflow-hidden">
          <TranscriptSidebar
            selectedItemId={selectedItemId}
            selectedRunId={selectedRunId}
            onSelectItem={(item) => { setSelectedItemId(item?.id ?? null); setSelectedRunId(null); }}
            onGenerate={setGenerateItem}
            onSelectRun={(runId) => setSelectedRunId(runId)}
          />
        </GlassCard>

        {/* 右侧：编辑区 */}
        <GlassCard animated glow className="flex flex-col min-h-0 p-0 overflow-hidden">
          <TranscriptEditor
            item={selectedItem}
            selectedRunId={selectedRunId}
            onItemDeleted={() => { setSelectedItemId(null); setSelectedRunId(null); }}
            onCloseRun={() => setSelectedRunId(null)}
          />
        </GlassCard>
      </div>

      {/* Generate dialog */}
      {generateItem && (
        <GenerateDialog
          open={!!generateItem}
          onOpenChange={(open) => { if (!open) setGenerateItem(null); }}
          item={generateItem}
          templates={templates}
        />
      )}
    </div>
  );
}
