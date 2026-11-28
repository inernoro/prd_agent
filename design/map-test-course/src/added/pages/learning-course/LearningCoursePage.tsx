import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CheckCircle2, ChevronLeft, RefreshCw } from 'lucide-react';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { getCourse, saveLessonProgress } from '@/services/real/learningCourses';
import { ArticleLesson } from './ArticleLesson';
import { CourseMetro } from './CourseMetro';
import { PdfLesson } from './PdfLesson';
import { PracticeTicket } from './PracticeTicket';
import { Act, SheetSkeleton } from './primitives';
import { MEDIA_ORDER, MEDIA_REGISTRY } from './registry';
import { VideoLesson } from './VideoLesson';
import type { Course, Lesson, LessonMediaKind, PracticeSummary } from './types';
import './learningCourse.css';

function unitOf(lesson: Lesson, kind: LessonMediaKind): string | null {
  const m = lesson.media;
  if (kind === 'video') return m.video ? MEDIA_REGISTRY.video.unit(m.video.durationSec) : null;
  if (kind === 'pdf') return m.pdf ? `P${m.pdf.lessonRange[0]}${m.pdf.lessonRange[1] > m.pdf.lessonRange[0] ? `–${m.pdf.lessonRange[1]}` : ''}` : null;
  return m.article ? `${m.article.readMinutes} 分钟` : null;
}

/* 课程页（检验台）：上面是课程路线，下面是书桌——主舞台放这一课的材料，伴读栏跟着材料变。
 * 地址记住当前课与材料（?lesson=&media=），刷新或分享后回到同一处。 */
export default function LearningCoursePage() {
  const { courseId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [course, setCourse] = useState<Course | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const res = await getCourse(courseId);
    if (res.success) setCourse(res.data); else setError(res.error?.message ?? '课程没有加载出来');
  }, [courseId]);
  useEffect(() => { void load(); }, [load]);

  const lesson = useMemo(() => {
    if (!course) return undefined;
    const want = params.get('lesson');
    return course.lessons.find(l => l.id === want) ?? course.lessons.find(l => l.status === 'current') ?? course.lessons[0];
  }, [course, params]);
  const media: LessonMediaKind = useMemo(() => {
    if (!lesson) return 'video';
    const want = params.get('media') as LessonMediaKind | null;
    return want && lesson.media[want] ? want : MEDIA_ORDER.find(k => lesson.media[k]) ?? 'article';
  }, [lesson, params]);

  const pick = (next: { lesson?: string; media?: LessonMediaKind }) => {
    const p = new URLSearchParams(params);
    if (next.lesson) { p.set('lesson', next.lesson); p.delete('media'); }
    if (next.media) p.set('media', next.media);
    setParams(p);
  };
  const report = useCallback(async (body: { media: LessonMediaKind; positionSec?: number; page?: number; completed?: boolean }) => {
    if (!course || !lesson) return;
    const res = await saveLessonProgress(course.id, lesson.id, body);
    if (res.success && res.data.status === 'done' && lesson.status !== 'done') {
      setCourse(c => c && { ...c, lessons: c.lessons.map(l => (l.id === lesson.id ? { ...l, status: 'done' } : l)) });
    }
  }, [course, lesson]);
  const openPractice = (p: PracticeSummary) => navigate(`/learning-center/courses/${encodeURIComponent(courseId)}/practice/${encodeURIComponent(p.id)}${p.runId ? `?run=${encodeURIComponent(p.runId)}` : ''}`);

  if (error) {
    return (
      <div className="lc-root h-full min-h-0 flex items-center justify-center">
        <div className="lc-panel p-6 max-w-md flex flex-col gap-3">
          <div className="t-meta t-mute">课程暂时打不开</div>
          <div className="t-strong">{error}</div>
          <div className="t-ui lc-ink2">你的学习进度已保存在服务端，重新加载即可接着学。</div>
          <Act tone="primary" onClick={() => void load()}><RefreshCw size={15} />重新加载</Act>
        </div>
      </div>
    );
  }
  if (!course || !lesson) return <SheetSkeleton label="正在打开课程…" />;

  const done = course.lessons.filter(l => l.status === 'done').length;
  const practicesDone = course.practices.filter(p => p.status === 'done').length;
  const minutes = course.lessons.reduce((s, l) => s + l.minutes, 0);
  const idx = course.lessons.findIndex(l => l.id === lesson.id);
  const prev = course.lessons[idx - 1];
  const next = course.lessons[idx + 1];

  const head = (
    <div className="lc-sheet-head">
      <div className="t-meta t-mute flex items-center gap-2">
        第 {lesson.index} 课 · {lesson.minutes} 分钟
        {lesson.status === 'done' && <span className="inline-flex items-center gap-1" style={{ color: 'var(--pass)' }}><CheckCircle2 size={12} />已学完</span>}
      </div>
      <h2 className="t-title mt-1">{lesson.title}</h2>
      <div className="lc-ruler" role="group" aria-label="学习材料" data-tour-id="course-media-switch">
        {MEDIA_ORDER.map(kind => {
          const unit = unitOf(lesson, kind);
          return (
            <button key={kind} type="button" className="lc-ruler-tab" aria-pressed={media === kind} disabled={!unit} title={unit ? undefined : lesson.missingReason?.[kind] ?? '本课没有这类材料'} data-lc={`media-${kind}`} onClick={() => pick({ media: kind })}>
              {MEDIA_REGISTRY[kind].label}<span className="lc-unit t-mute">{unit ?? '无'}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
  const ticket = <PracticeTicket key={lesson.id} practices={course.practices} suggestedId={lesson.practiceIds[0]} onStart={openPractice} />;
  const common = { head, keyPoints: lesson.keyPoints, ticket };

  return (
    <div className={`lc-root h-full min-h-0 flex flex-col gap-3 ${isMobile ? 'lc-mobile lc-scroll' : ''}`} data-lc-ready="course">
      <header className="lc-panel lc-head shrink-0">
        <Link to="/learning-center" className="lc-link t-meta" data-lc="back-center" aria-label="回到学习中心"><ChevronLeft size={14} />学习中心</Link>
        <div className={`flex gap-4 ${isMobile ? 'flex-col' : 'items-end justify-between'}`}>
          <div className="min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="t-display">{course.title}</h1>
              {course.wip && <span className="t-meta t-mute px-2 rounded-[6px]" style={{ border: '1px solid var(--line-2)' }}>试运行</span>}
            </div>
            {!isMobile && <p className="t-mute mt-1">{course.subtitle}</p>}
          </div>
          <div className="flex items-center gap-4 t-meta t-mute lc-num shrink-0" data-lc="course-progress">
            <span>已学 {done}/{course.lessons.length} 课</span>
            <span>练习 {practicesDone}/{course.practices.length}</span>
            <span>约 {minutes} 分钟</span>
            {!isMobile && <span className="flex items-center">
              <Act tone="ghost" disabled={!prev} onClick={() => prev && pick({ lesson: prev.id })} aria-label="上一课"><ArrowLeft size={15} /></Act>
              <Act tone="ghost" disabled={!next} onClick={() => next && pick({ lesson: next.id })} aria-label="下一课"><ArrowRight size={15} /></Act>
            </span>}
          </div>
        </div>
        <CourseMetro course={course} activeId={lesson.id} onLesson={l => pick({ lesson: l.id })} />
      </header>

      <div className={isMobile ? 'flex flex-col' : 'flex-1 min-h-0 flex flex-col'} key={`${lesson.id}-${media}`}>
        {media === 'video' && lesson.media.video && <VideoLesson {...common} video={lesson.media.video} onProgress={(sec, completed) => void report({ media: 'video', positionSec: sec, completed })} />}
        {media === 'pdf' && lesson.media.pdf && <PdfLesson {...common} pdf={lesson.media.pdf} onPage={page => void report({ media: 'pdf', page })} />}
        {media === 'article' && lesson.media.article && <ArticleLesson {...common} article={lesson.media.article} onFinished={() => void report({ media: 'article', completed: true })} />}
      </div>
    </div>
  );
}
