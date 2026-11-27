import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Clock, FlaskConical, Layers } from 'lucide-react';
import { listCourses } from '@/services/real/learningCourses';
import type { CourseSummary } from './types';
import './learningCourse.css';

/* 学习中心的「课程」区：系统化的课程与短教程分开放，课程卡给出进度和下一课。 */
export function CourseShelf() {
  const navigate = useNavigate();
  const [items, setItems] = useState<CourseSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listCourses().then(res => (res.success ? setItems(res.data.items) : setError(res.error?.message ?? '课程列表没有加载出来')));
  }, []);

  if (error) return <div className="text-[12.5px] lc-muted">课程暂时没加载出来（{error}），稍后刷新即可，短教程不受影响。</div>;
  if (!items || items.length === 0) return null;

  return (
    <section className="flex flex-col gap-3" data-tour-id="learning-courses" data-lc-ready="center" aria-label="课程">
      <div className="flex items-center gap-2">
        <Layers size={15} style={{ color: 'var(--accent-primary)' }} />
        <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>课程</span>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>成体系地学一项技能：视频、PDF 教材、图文，配练习 · {items.length} 门</span>
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 560px), 1fr))' }}>
        {items.map(c => {
          const pct = Math.round((c.progress.lessonsDone / c.lessonCount) * 100);
          const started = c.progress.lessonsDone > 0;
          return (
            <button
              key={c.id}
              type="button"
              className="lc-practice-card"
              style={{ padding: 0, overflow: 'hidden', minHeight: 148 }}
              onClick={() => navigate(`/learning-center/courses/${encodeURIComponent(c.id)}${c.progress.nextLessonId ? `?lesson=${encodeURIComponent(c.progress.nextLessonId)}` : ''}`)}
              data-lc="course-card"
            >
              {c.coverUrl && <img src={c.coverUrl} alt="" className="hidden sm:block shrink-0 object-cover" style={{ width: 200, height: '100%', minHeight: 156 }} />}
              <span className="flex flex-col gap-2 p-3.5 min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-[15px] font-bold truncate" style={{ color: 'var(--text-primary)' }}>{c.title}</span>
                  {c.wip && <span className="text-[10.5px] px-2 py-0.5 rounded-full shrink-0" style={{ border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}>试运行</span>}
                </span>
                <span className="text-[12px] leading-relaxed line-clamp-2" style={{ color: 'var(--text-secondary)' }}>{c.subtitle}</span>
                <span className="flex items-center gap-3 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                  <span className="inline-flex items-center gap-1"><Clock size={11} />{c.lessonCount} 课 · 约 {c.minutes} 分钟</span>
                  <span className="inline-flex items-center gap-1"><FlaskConical size={11} />练习 {c.progress.practicesDone} 次完成</span>
                </span>
                <span className="flex items-center gap-3 mt-auto">
                  <span className="lc-progress-track flex-1"><span className="lc-progress-fill block" style={{ width: `${Math.max(pct, 2)}%` }} /></span>
                  <span className="text-[12px] font-semibold inline-flex items-center gap-1 shrink-0" style={{ color: 'var(--text-primary)' }}>
                    {started ? '继续' : '开始'}{c.progress.nextLessonTitle ? `：${c.progress.nextLessonTitle}` : ''}<ArrowRight size={13} />
                  </span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
