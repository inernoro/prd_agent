import { useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { Sparkles, Loader2 } from 'lucide-react';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { toast } from '@/lib/toast';
import type { TranscriptItem, TranscriptTemplate } from '@/services/contracts/transcriptAgent';

interface GenerateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: TranscriptItem;
  templates: TranscriptTemplate[];
}

export function GenerateDialog({ open, onOpenChange, item, templates }: GenerateDialogProps) {
  const { createCopywrite } = useTranscriptStore();
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [generating, setGenerating] = useState(false);

  const handleGenerate = async () => {
    if (!selectedTemplateId) return;
    setGenerating(true);
    const run = await createCopywrite(item.id, selectedTemplateId);
    if (run) {
      toast.success('文案生成任务已提交');
      onOpenChange(false);
    }
    setGenerating(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="生成文案产物"
      maxWidth={480}
      content={
        <div className="space-y-4 pt-2">
          <div className="text-sm text-muted-foreground">
            基于「{item.fileName}」的转录文本，使用模板生成文案
          </div>

          {/* Template selection */}
          <div>
            <label className="block text-sm font-medium mb-2">选择模板</label>
            <div className="space-y-1.5">
              {templates.map(t => (
                <button
                  key={t.id}
                  onClick={() => setSelectedTemplateId(t.id)}
                  className={`surface-row w-full text-left px-3 py-2.5 rounded-lg transition-colors text-sm ${
                    selectedTemplateId === t.id
                      ? 'border border-primary/30'
                      : 'border border-transparent'
                  }`}
                  data-active={selectedTemplateId === t.id || undefined}
                >
                  <div className="font-medium">{t.name}</div>
                  {t.description && (
                    <div className="text-xs text-muted-foreground mt-0.5">{t.description}</div>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button size="sm" onClick={handleGenerate} disabled={!selectedTemplateId || generating}>
              {generating ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Sparkles className="w-4 h-4 mr-1" />}
              生成
            </Button>
          </div>
        </div>
      }
    />
  );
}
