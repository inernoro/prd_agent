import { useMemo, useEffect, useRef, useCallback } from 'react';
import type { TranscriptSegment } from '@/services/contracts/transcriptAgent';
import { SegmentRow } from './SegmentRow';

interface SegmentListProps {
  segments: TranscriptSegment[];
  currentTime?: number;
  onSeek?: (time: number) => void;
  onTextChange?: (index: number, newText: string) => void;
  className?: string;
}

export function SegmentList({ segments, currentTime, onSeek, onTextChange, className }: SegmentListProps) {
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  // Find active segment index based on currentTime
  const activeIndex = useMemo(() => {
    if (currentTime === undefined || segments.length === 0) return -1;
    for (let i = segments.length - 1; i >= 0; i--) {
      if (currentTime >= segments[i].start) {
        // Also check that we haven't passed the end (with a small tolerance)
        if (currentTime < segments[i].end || i === segments.length - 1) {
          return i;
        }
      }
    }
    return -1;
  }, [currentTime, segments]);

  // Auto-scroll to active segment
  useEffect(() => {
    if (activeIndex < 0) return;
    const el = rowRefs.current.get(activeIndex);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeIndex]);

  // Callback ref pattern for row refs
  const setRowRef = useCallback((index: number, el: HTMLDivElement | null) => {
    if (el) {
      rowRefs.current.set(index, el);
    } else {
      rowRefs.current.delete(index);
    }
  }, []);

  if (segments.length === 0) {
    return (
      <div className={`flex items-center justify-center py-12 ${className ?? ''}`}>
        <p className="text-sm text-muted-foreground">暂无转录段落</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className={className}>
      {segments.map((seg, i) => (
        <SegmentRow
          key={i}
          segment={seg}
          index={i}
          isActive={i === activeIndex}
          onSeek={() => onSeek?.(seg.start)}
          onTextChange={onTextChange}
          rowRef={(el) => setRowRef(i, el as HTMLDivElement | null)}
        />
      ))}
    </div>
  );
}
