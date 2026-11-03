import { useRef, useState } from 'react';
import { ImagePlus, Library, Plus, Send, Square, X } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import KnowledgeEntryPicker from '@/components/knowledge/KnowledgeEntryPicker';
import { DESIGN_ATTACHMENT_ACCEPT, MAX_EDIT_SCREENSHOTS } from './designAttachments';
import type { useSiteEditSession } from './workbench/useSiteEditSession';

type Props = Pick<ReturnType<typeof useSiteEditSession>,
  'instruction' | 'setInstruction' | 'generating' | 'generate' | 'stopGeneration' |
  'activeRunId' | 'stopRequested' | 'recentKnowledge' | 'selectedKnowledge' |
  'setSelectedKnowledge' | 'loadingKnowledge' | 'screenshots' | 'screenshotsSupported' | 'addScreenshots'>;

/** 阅读页修改入口：附件和知识都从输入框的添加菜单进入。 */
export default function SiteEditComposer(props: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const attachmentsPending = props.screenshots.items.some((item) => item.status !== 'ready');
  const submit = () => {
    if (!props.generating && props.instruction.trim() && !attachmentsPending) void props.generate();
  };
  return <div className="shrink-0 border-t border-token-subtle bg-token-elevated p-3">
    {(props.selectedKnowledge.length > 0 || props.screenshots.items.length > 0) && <div className="mb-2 flex flex-wrap gap-1.5" aria-label="已添加的内容">
      {props.selectedKnowledge.map((entry) => <span key={`${entry.storeId}:${entry.entryId}`} className="inline-flex max-w-full items-center gap-1 rounded-md bg-token-nested px-2 py-1 text-xs">
        <Library size={12} /><span className="max-w-40 truncate">{entry.title}</span>
        <button type="button" disabled={props.generating} aria-label={`移除引用 ${entry.title}`} onClick={() => props.setSelectedKnowledge(props.selectedKnowledge.filter((item) => item !== entry))}><X size={12} /></button>
      </span>)}
      {props.screenshots.items.map((item) => <span key={item.key} className="inline-flex max-w-full items-center gap-1 rounded-md bg-token-nested px-2 py-1 text-xs" title={item.error || item.fileName}>
        {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" className="h-6 w-6 rounded object-cover" /> : <ImagePlus size={12} />}
        <span className="max-w-36 truncate">{item.fileName}</span>
        {item.status !== 'ready' && <span role="status">{item.status === 'uploading' ? `${item.progress}%` : item.status === 'failed' ? '失败' : '读取中'}</span>}
        <button type="button" disabled={props.generating} aria-label={`删除截图 ${item.fileName}`} onClick={() => props.screenshots.remove(item.key)}><X size={12} /></button>
      </span>)}
    </div>}
    <div className="relative flex items-end gap-1 rounded-2xl border border-token-default bg-token-input p-1.5 focus-within:border-blue-500"
      onPaste={(event) => {
        if (props.generating || !props.screenshotsSupported) return;
        const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'));
        if (images.length) { event.preventDefault(); props.addScreenshots(images); }
      }}>
      <button type="button" aria-label="添加引用或图片" aria-expanded={menuOpen} disabled={props.generating}
        onClick={() => setMenuOpen((open) => !open)} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-token-secondary hover-bg-soft"><Plus size={19} /></button>
      {menuOpen && <div className="absolute bottom-full left-0 z-10 mb-2 w-44 rounded-lg border border-token-subtle bg-token-elevated p-1 shadow-xl">
        <button type="button" onClick={() => { setMenuOpen(false); setKnowledgeOpen(true); }} className="flex min-h-11 w-full items-center gap-2 rounded px-3 text-xs hover-bg-soft"><Library size={14} />引用知识</button>
        <button type="button" disabled={!props.screenshotsSupported || props.screenshots.items.length >= MAX_EDIT_SCREENSHOTS}
          title={props.screenshotsSupported ? undefined : '设计服务就绪后可用'}
          onClick={() => { setMenuOpen(false); inputRef.current?.click(); }} className="flex min-h-11 w-full items-center gap-2 rounded px-3 text-xs hover-bg-soft disabled:opacity-40"><ImagePlus size={14} />添加图片</button>
      </div>}
      <textarea aria-label="修改要求" value={props.instruction} disabled={props.generating} maxLength={4000}
        rows={2} placeholder="说说你想怎么修改…" onChange={(event) => props.setInstruction(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
          if (event.key === 'Escape' && menuOpen) { event.stopPropagation(); setMenuOpen(false); }
        }} className="max-h-36 min-h-10 min-w-0 flex-1 resize-none bg-transparent py-2 text-base text-token-primary outline-none sm:text-sm" />
      {props.generating ? <button type="button" aria-label="停止生成" disabled={!props.activeRunId || props.stopRequested}
        onClick={() => void props.stopGeneration()} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-token-secondary disabled:opacity-40"><Square size={16} /></button>
        : <button type="button" aria-label="生成修改草稿" disabled={!props.instruction.trim() || attachmentsPending}
          onClick={submit} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white disabled:opacity-40"><Send size={16} /></button>}
    </div>
    <p className="mt-1.5 text-center text-[10px] text-token-muted">生成草稿后可预览，确认发布才会更新网页。</p>
    <input ref={inputRef} type="file" multiple accept={DESIGN_ATTACHMENT_ACCEPT.image} className="hidden"
      onChange={(event) => { props.addScreenshots(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
    <Dialog open={knowledgeOpen} onOpenChange={setKnowledgeOpen} title="引用知识"
      content={<KnowledgeEntryPicker recentEntries={props.recentKnowledge} selectedEntries={props.selectedKnowledge}
        onChange={props.setSelectedKnowledge} loadingRecent={props.loadingKnowledge} disabled={props.generating} compact />} />
  </div>;
}
