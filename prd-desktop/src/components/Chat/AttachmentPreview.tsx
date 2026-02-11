import { AttachmentInfo } from '../../types';

interface Props {
  attachments: AttachmentInfo[];
  onRemove: (attachmentId: string) => void;
}

export default function AttachmentPreview({ attachments, onRemove }: Props) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-2 overflow-x-auto">
      {attachments.map((att) => (
        <div
          key={att.attachmentId}
          className="relative flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden border border-black/10 dark:border-white/10 group"
        >
          <img
            src={att.url}
            alt={att.fileName}
            className="w-full h-full object-cover"
          />
          <button
            type="button"
            onClick={() => onRemove(att.attachmentId)}
            className="absolute top-0.5 right-0.5 w-5 h-5 flex items-center justify-center rounded-full bg-black/60 text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity"
            aria-label="移除"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          {/* 上传中指示器 */}
          <div className="absolute bottom-0 left-0 right-0 text-[9px] text-white bg-black/40 text-center truncate px-0.5">
            {att.fileName.length > 10 ? att.fileName.slice(0, 8) + '...' : att.fileName}
          </div>
        </div>
      ))}
    </div>
  );
}
