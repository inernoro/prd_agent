import { MEDIA_ORDER, MEDIA_REGISTRY } from './registry';
import type { Lesson, LessonMediaKind } from './types';

function unitOf(lesson: Lesson, kind: LessonMediaKind): number | null {
  const m = lesson.media;
  if (kind === 'video') return m.video ? m.video.durationSec : null;
  if (kind === 'pdf') return m.pdf ? m.pdf.lessonRange[1] - m.pdf.lessonRange[0] + 1 : null;
  return m.article ? m.article.readMinutes : null;
}

/* 视频 / PDF / 图文切换。本课没有的材料留在原位、不可点，并写出原因。 */
export function MediaSwitch({ lesson, value, onChange }: { lesson: Lesson; value: LessonMediaKind; onChange: (k: LessonMediaKind) => void }) {
  return (
    <div className="lc-media-switch" role="group" aria-label="学习材料" data-tour-id="course-media-switch">
      {MEDIA_ORDER.map(kind => {
        const meta = MEDIA_REGISTRY[kind];
        const n = unitOf(lesson, kind);
        const Icon = meta.icon;
        const reason = n == null ? lesson.missingReason?.[kind] ?? '本课没有这类材料' : undefined;
        return (
          <button
            key={kind}
            type="button"
            className="lc-media-btn"
            aria-pressed={value === kind}
            disabled={n == null}
            title={reason}
            data-lc={`media-${kind}`}
            onClick={() => onChange(kind)}
          >
            <Icon size={15} />
            {meta.label}
            <span className="lc-unit">{n == null ? '无' : kind === 'pdf' ? `本课 ${n} 页` : meta.unit(n)}</span>
          </button>
        );
      })}
    </div>
  );
}
