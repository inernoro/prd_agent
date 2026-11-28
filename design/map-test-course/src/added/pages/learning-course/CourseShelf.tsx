import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { listCourses } from '@/services/real/learningCourses';
import type { CourseSummary } from './types';
import './learningCourse.css';

/* 学习中心的「课程」区：每门课是一张横幅，迷你路线标出学到哪一站、下一站是哪。 */
export function CourseShelf() {
  const navigate = useNavigate();
  const [items, setItems] = useState<CourseSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void listCourses().then(res => (res.success ? setItems(res.data.items) : setError(res.error?.message ?? '课程列表没有加载出来'))); }, []);

  if (error) return <div className="text-[12.5px]" style={{ color: 'var(--text-muted)' }}>课程暂时没加载出来（{error}），稍后刷新即可，短教程不受影响。</div>;
  if (!items?.length) return null;
  return (
    <section className="lc-root flex flex-col gap-3" data-tour-id="learning-courses" data-lc-ready="center" aria-label="课程">
      <div className="flex items-baseline gap-3">
        <span className="lc-kicker" style={{ color: 'var(--lc-hi)' }}>课程</span>
        <span className="text-[14px] font-semibold">成体系地学一项技能</span>
        <span className="text-[12px] lc-ink3">视频、PDF 教材、图文任选，配动手练习</span>
      </div>
      {items.map(c => {
        const nextIdx = c.progress.nextLessonId ? Number(c.progress.nextLessonId.replace(/\D/g, '')) - 1 : c.lessonCount;
        return (
          <button key={c.id} type="button" className="lc-banner" data-lc="course-card"
            onClick={() => navigate(`/learning-center/courses/${encodeURIComponent(c.id)}${c.progress.nextLessonId ? `?lesson=${encodeURIComponent(c.progress.nextLessonId)}` : ''}`)}>
            <span className="lc-banner-orb" aria-hidden />
            <span className="flex items-start gap-4 flex-wrap relative">
              <span className="min-w-0 flex-1" style={{ minWidth: 240 }}>
                <span className="flex items-center gap-2.5">
                  <span className="text-[20px] font-bold" style={{ letterSpacing: '-0.01em' }}>{c.title}</span>
                  {c.wip && <span className="lc-tag">试运行</span>}
                </span>
                <span className="block text-[12.5px] lc-ink2 mt-1 leading-relaxed">{c.subtitle}</span>
              </span>
              <span className="flex items-center gap-5">
                <span className="lc-stat"><b>{c.lessonCount}</b>课</span>
                <span className="lc-stat">约<b>{c.minutes}</b>分钟</span>
                <span className="lc-stat">练习<b>{c.progress.practicesDone}</b>次完成</span>
              </span>
            </span>
            <span className="lc-mini-metro relative" style={{ ['--n' as string]: c.lessonCount }}>
              {Array.from({ length: c.lessonCount }, (_, i) => (
                <span key={i} className="lc-mini-stop" data-done={i < c.progress.lessonsDone} data-next={i === nextIdx}>
                  <i>{i + 1}</i>{c.lessonShortTitles[i] ?? `第 ${i + 1} 课`}
                </span>
              ))}
            </span>
            <span className="flex items-center justify-end gap-2 text-[13px] font-semibold relative" style={{ color: 'var(--lc-hi)' }}>
              {c.progress.lessonsDone > 0 ? '继续' : '开始'}{c.progress.nextLessonTitle ? `：${c.progress.nextLessonTitle}` : ''}<ArrowRight size={14} />
            </span>
          </button>
        );
      })}
    </section>
  );
}
