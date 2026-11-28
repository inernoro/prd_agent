import type { Course, Lesson } from './types';

/* 课程路线：五课是一条线上的五站，已学实心、当前站强调色，轨道填到当前站。练习入口在右侧伴读栏。 */
export function CourseMetro({ course, activeId, onLesson }: { course: Course; activeId: string; onLesson: (l: Lesson) => void }) {
  const n = course.lessons.length;
  const activeIdx = Math.max(0, course.lessons.findIndex(l => l.id === activeId));
  const reached = Math.max(activeIdx, course.lessons.reduce((m, l, i) => (l.status === 'done' ? i : m), -1));
  const half = 50 / n;
  return (
    <nav className="lc-metro" style={{ ['--n' as string]: n }} aria-label="课程路线" data-tour-id="course-lessons">
      <span className="lc-metro-rail" style={{ left: `${half}%`, right: `${half}%` }} aria-hidden />
      <span className="lc-metro-fill" style={{ left: `${half}%`, width: `${(reached / n) * 100}%` }} aria-hidden />
      {course.lessons.map(lesson => (
        <button key={lesson.id} type="button" className="lc-station" data-status={lesson.status} aria-current={lesson.id === activeId} data-lc="lesson-row" data-lesson={lesson.id} onClick={() => onLesson(lesson)}>
          <span className="lc-station-dot" />
          <span>{lesson.index}. {lesson.title.split('：')[0]}</span>
        </button>
      ))}
    </nav>
  );
}
