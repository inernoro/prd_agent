import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { listCourses } from '@/services/real/learningCourses';
import type { CourseSummary } from './types';
import './learningCourse.css';

/* 学习中心的「课程」区：每门课一张卡，路线标出学到哪、下一课是哪。 */
export function CourseShelf() {
  const navigate = useNavigate();
  const [items, setItems] = useState<CourseSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void listCourses().then(res => (res.success ? setItems(res.data.items) : setError(res.error?.message ?? '课程列表没有加载出来'))); }, []);

  if (error) return <div className="t-meta" style={{ color: 'var(--text-muted)' }}>课程暂时没加载出来（{error}），稍后刷新即可，短教程不受影响。</div>;
  if (!items?.length) return null;
  return (
    <section className="lc-root flex flex-col gap-3" data-tour-id="learning-courses" data-lc-ready="center" aria-label="课程">
      <div className="flex items-baseline gap-3"><h2 className="t-strong">课程</h2><span className="t-meta t-mute">成体系地学一项技能，视频、PDF 教材、图文任选，配动手练习</span></div>
      {items.map(c => {
        const nextIdx = c.progress.nextLessonId ? Number(c.progress.nextLessonId.replace(/\D/g, '')) - 1 : c.lessonCount;
        return (
          <button key={c.id} type="button" className="lc-banner" data-lc="course-card"
            onClick={() => navigate(`/learning-center/courses/${encodeURIComponent(c.id)}${c.progress.nextLessonId ? `?lesson=${encodeURIComponent(c.progress.nextLessonId)}` : ''}`)}>
            <span className="flex items-end justify-between gap-4 flex-wrap">
              <span className="min-w-0">
                <span className="flex items-center gap-3"><span className="t-title t-strong">{c.title}</span>{c.wip && <span className="t-meta t-mute px-2 rounded-[6px]" style={{ border: '1px solid var(--line-2)' }}>试运行</span>}</span>
                <span className="block t-mute mt-1">{c.subtitle}</span>
              </span>
              <span className="t-meta t-mute lc-num">{c.lessonCount} 课 · 约 {c.minutes} 分钟 · 练习完成 {c.progress.practicesDone} 次</span>
            </span>
            <span className="lc-mini-metro" style={{ ['--n' as string]: c.lessonCount }}>
              {Array.from({ length: c.lessonCount }, (_, i) => (
                <span key={i} className="lc-mini-stop" data-done={i < c.progress.lessonsDone} data-next={i === nextIdx}><i />{c.lessonShortTitles[i] ?? `第 ${i + 1} 课`}</span>
              ))}
            </span>
            <span className="flex items-center justify-end gap-1.5 t-strong" style={{ color: 'var(--hi)' }}>
              {c.progress.lessonsDone > 0 ? '继续' : '开始'}{c.progress.nextLessonTitle ? `：${c.progress.nextLessonTitle}` : ''}<ArrowRight size={15} />
            </span>
          </button>
        );
      })}
    </section>
  );
}
