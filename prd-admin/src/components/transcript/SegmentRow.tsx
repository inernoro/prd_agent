import { useState, useEffect, useRef } from 'react';
import type { TranscriptSegment } from '@/services/contracts/transcriptAgent';

interface SegmentRowProps {
  segment: TranscriptSegment;
  index: number;
  isActive?: boolean;
  onSeek?: () => void;
  onTextChange?: (index: number, newText: string) => void;
  rowRef?: React.Ref<HTMLDivElement>;
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    : `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function SegmentRow({ segment, index, isActive, onSeek, onTextChange, rowRef }: SegmentRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(segment.text);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync editText when segment text changes externally
  useEffect(() => {
    if (!isEditing) setEditText(segment.text);
  }, [segment.text, isEditing]);

  // Auto-focus when entering edit mode
  useEffect(() => {
    if (isEditing) inputRef.current?.focus();
  }, [isEditing]);

  const handleBlur = () => {
    setIsEditing(false);
    const trimmed = editText.trim();
    if (trimmed !== segment.text && trimmed.length > 0) {
      onTextChange?.(index, trimmed);
    } else {
      setEditText(segment.text);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setEditText(segment.text);
      setIsEditing(false);
    } else if (e.key === 'Enter') {
      inputRef.current?.blur();
    }
  };

  return (
    <div
      ref={rowRef}
      className={`flex gap-4 py-2.5 px-3 rounded-lg cursor-pointer transition-colors group ${
        isActive
          ? 'bg-blue-500/[0.08] border-l-2 border-blue-400'
          : 'hover:bg-white/[0.04]'
      }`}
    >
      {/* Timestamp */}
      <span
        className={`font-mono text-xs pt-0.5 w-16 shrink-0 text-right tabular-nums cursor-pointer transition-colors ${
          isActive ? 'text-blue-400/60' : 'text-white/25 hover:text-white/40'
        }`}
        onClick={onSeek}
      >
        {formatTime(segment.start)}
      </span>

      {/* Text area */}
      {isEditing ? (
        <input
          ref={inputRef}
          className="text-sm text-white/90 leading-relaxed flex-1 bg-transparent border-b border-white/10 outline-none focus:border-blue-400/40"
          value={editText}
          onChange={e => setEditText(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
        />
      ) : (
        <span
          className={`text-sm leading-relaxed flex-1 ${
            isActive ? 'text-white/90' : 'text-white/75'
          }`}
          onClick={() => setIsEditing(true)}
        >
          {segment.text}
        </span>
      )}
    </div>
  );
}
