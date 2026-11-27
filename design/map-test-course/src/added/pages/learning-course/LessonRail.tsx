import { CheckCircle2, ChevronRight, Clock } from 'lucide-react';
import { MEDIA_ORDER, MEDIA_REGISTRY, SKILL_REGISTRY } from './registry';
import type { Course, Lesson, PracticeSummary } from './types';

const PRACTICE_STATUS: Record<PracticeSummary['status'], string> = { todo: '未开始', doing: '进行中，可续上', done: '已完成' };

/* 课程目录 + 练习选择。桌面在左栏，手机由页内切换展示。 */
export function LessonRail({ course, activeLessonId, onPickLesson, onPickPractice }: {
  course: Course;
  activeLessonId: string;
  onPickLesson: (lesson: Lesson) => void;
  onPickPractice: (practice: PracticeSummary) => void;
}) {
  return (
    <nav className="flex flex-col gap-5" aria-label="课程目录">
      <section className="flex flex-col gap-1" data-tour-id="course-lessons">
        <div className="lc-eyebrow px-2.5 pb-1">课程目录 · {course.lessons.length} 课</div>
        {course.lessons.map(lesson => (
          <button
            key={lesson.id}
            type="button"
            className="lc-lesson"
            data-status={lesson.status}
            aria-current={lesson.id === activeLessonId}
            data-lc="lesson-row" data-lesson={lesson.id}
            onClick={() => onPickLesson(lesson)}
          >
            <span className="lc-lesson-index">{lesson.status === 'done' ? <CheckCircle2 size={14} /> : lesson.index}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-semibold leading-snug" style={{ color: 'var(--text-primary)' }}>{lesson.title}</span>
              <span className="mt-1 flex items-center gap-2 text-[11.5px] lc-muted">
                <Clock size={11} />{lesson.minutes} 分钟
                <span className="inline-flex items-center gap-1.5">
                  {MEDIA_ORDER.filter(k => lesson.media[k]).map(k => {
                    const Icon = MEDIA_REGISTRY[k].icon;
                    return <Icon key={k} size={12} aria-label={MEDIA_REGISTRY[k].label} />;
                  })}
                </span>
              </span>
            </span>
          </button>
        ))}
      </section>

      <section className="flex flex-col gap-2" data-tour-id="course-practices">
        <div className="px-2.5">
          <div className="lc-eyebrow">练习 · 选一个亲手做</div>
          <p className="text-[12px] lc-muted mt-1 leading-relaxed">每个练习都走完一遍：Agent 检查 → 你判断 → 修复 → 复测 → 交付。</p>
        </div>
        {course.practices.map(p => {
          const skill = SKILL_REGISTRY[p.skill];
          const Icon = skill.icon;
          return (
            <button key={p.id} type="button" className="lc-practice-card" data-lc="practice-card" data-practice={p.id} data-status={p.status} onClick={() => onPickPractice(p)}>
              <span className="lc-nested inline-flex items-center justify-center shrink-0" style={{ width: 36, height: 36 }}><Icon size={17} style={{ color: 'var(--accent-primary)' }} /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold leading-snug" style={{ color: 'var(--text-primary)' }}>{p.title}</span>
                <span className="block text-[11.5px] lc-muted mt-1">{skill.label} · 约 {p.minutes} 分钟 · {PRACTICE_STATUS[p.status]}</span>
              </span>
              <ChevronRight size={15} className="lc-muted self-center shrink-0" />
            </button>
          );
        })}
      </section>
    </nav>
  );
}
