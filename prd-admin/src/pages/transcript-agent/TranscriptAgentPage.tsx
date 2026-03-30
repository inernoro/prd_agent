import { useEffect, useState } from 'react';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { TranscriptSidebar } from '@/components/transcript/TranscriptSidebar';
import { TranscriptEditor } from '@/components/transcript/TranscriptEditor';
import type { TranscriptItem } from '@/services/contracts/transcriptAgent';

export default function TranscriptAgentPage() {
  const { items, refreshItems } = useTranscriptStore();
  const [selectedItem, setSelectedItem] = useState<TranscriptItem | null>(null);

  // Auto-poll pending/processing items
  useEffect(() => {
    const pending = items.filter(i => i.transcribeStatus === 'pending' || i.transcribeStatus === 'processing');
    if (pending.length === 0) return;
    const timer = setInterval(() => refreshItems(), 3000);
    return () => clearInterval(timer);
  }, [items, refreshItems]);

  // Keep selectedItem in sync with store items
  useEffect(() => {
    if (selectedItem) {
      const updated = items.find(i => i.id === selectedItem.id);
      if (updated) setSelectedItem(updated);
    }
  }, [items]);

  return (
    <div className="flex h-full">
      <TranscriptSidebar
        selectedItemId={selectedItem?.id ?? null}
        onSelectItem={setSelectedItem}
      />
      <div className="flex-1 min-w-0">
        <TranscriptEditor
          item={selectedItem}
          onItemDeleted={() => setSelectedItem(null)}
        />
      </div>
    </div>
  );
}
