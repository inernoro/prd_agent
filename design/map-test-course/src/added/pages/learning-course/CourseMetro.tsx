import { Check } from 'lucide-react';
import { SKILL_REGISTRY } from './registry';
import type { Course, Lesson, PracticeSummary } from './types';

/* 课程路线：五站是五课，站下的菱形支线是练习。一眼看到学到哪、下一站在哪、哪里能下车练手。 */
export function CourseMetro({ course, activeId, onLesson, onPractice }: {
  course: Course;
  activeId: string;
  onLesson: (l: Lesson) => void;
  onPractice: (p: PracticeSummary) => void;
}) {
  const n = course.lessons.length;
  const activeIdx = Math.max(0, course.lessons.findIndex(l => l.id === activeId));
  const reached = Math.max(activeIdx, course.lessons.reduce((m, l, i) => (l.status === 'done' ? i : m), -1));
  const branchesOf = (lesson: Lesson) => course.practices.filter(p => p.lessonIds[0] === lesson.id);
  const half = 50 / n;
  return (
    <nav className="lc-metro" style={{ ['--n' as string]: n }} aria-label="课程路线" data-tour-id="course-lessons">
      <span className="lc-metro-rail" style={{ left: `${half}%`, right: `${half}%` }} aria-hidden />
      <span className="lc-metro-fill" style={{ left: `${half}%`, width: `${(reached / n) * 100}%` }} aria-hidden />
      {course.lessons.map(lesson => (
        <div key={lesson.id} className="flex flex-col items-center gap-2">
          <button type="button" className="lc-station" data-status={lesson.status} aria-current={lesson.id === activeId} data-lc="lesson-row" data-lesson={lesson.id} onClick={() => onLesson(lesson)}>
            <span className="lc-station-dot">{lesson.status === 'done' ? <Check size={17} strokeWidth={2.6} /> : String(lesson.index).padStart(2, '0')}</span>
            <span className="lc-station-name">{lesson.title.split('：')[0]}</span>
          </button>
          <div className="flex flex-col items-center gap-1.5" data-tour-id="course-practices">
            {branchesOf(lesson).map(p => (
              <button key={p.id} type="button" className="lc-branch" data-lc="practice-card" data-practice={p.id} data-status={p.status} onClick={() => onPractice(p)} title={p.title} data-qc-touch-exempt>
                练习 · {SKILL_REGISTRY[p.skill].label}{p.status === 'done' ? ' · 已完成' : p.status === 'doing' ? ' · 进行中' : ''}
              </button>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}
