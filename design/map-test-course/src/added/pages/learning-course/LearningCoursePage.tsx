import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CheckCircle2, ChevronLeft, FlaskConical, GraduationCap, RefreshCw } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { SegmentedTabs } from '@/components/design/SegmentedTabs';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { getCourse, saveLessonProgress } from '@/services/real/learningCourses';
import { ArticleLesson } from './ArticleLesson';
import { LessonRail } from './LessonRail';
import { MediaSwitch } from './MediaSwitch';
import { PdfLesson } from './PdfLesson';
import { MEDIA_ORDER, SKILL_REGISTRY } from './registry';
import { VideoLesson } from './VideoLesson';
import type { Course, Lesson, LessonMediaKind, PracticeSummary } from './types';
import './learningCourse.css';

/* 课程页：左边目录与练习，右边当前这一课。一课可以有视频、PDF 教材、图文三种材料，学员自选。
 * 地址记住当前课与材料（?lesson=&media=），刷新或分享后回到同一处。 */
export default function LearningCoursePage() {
  const { courseId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [course, setCourse] = useState<Course | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<'lesson' | 'outline'>('lesson');

  const load = useCallback(async () => {
    setError(null);
    const res = await getCourse(courseId);
    if (res.success) setCourse(res.data);
    else setError(res.error?.message ?? '课程没有加载出来');
  }, [courseId]);
  useEffect(() => { void load(); }, [load]);

  const lesson: Lesson | undefined = useMemo(() => {
    if (!course) return undefined;
    const wanted = params.get('lesson');
    return course.lessons.find(l => l.id === wanted) ?? course.lessons.find(l => l.status === 'current') ?? course.lessons[0];
  }, [course, params]);

  const media: LessonMediaKind = useMemo(() => {
    if (!lesson) return 'video';
    const wanted = params.get('media') as LessonMediaKind | null;
    if (wanted && lesson.media[wanted]) return wanted;
    return MEDIA_ORDER.find(k => lesson.media[k]) ?? 'article';
  }, [lesson, params]);

  const pick = (next: { lesson?: string; media?: LessonMediaKind }) => {
    const p = new URLSearchParams(params);
    if (next.lesson) { p.set('lesson', next.lesson); p.delete('media'); }
    if (next.media) p.set('media', next.media);
    setParams(p, { replace: false });
  };

  /* 进度由服务端裁定：返回本课状态后，只更新这一课，不整页重载 */
  const report = useCallback(async (body: { media: LessonMediaKind; positionSec?: number; page?: number; completed?: boolean }) => {
    if (!course || !lesson) return;
    const res = await saveLessonProgress(course.id, lesson.id, body);
    if (res.success && res.data.status === 'done' && lesson.status !== 'done') {
      setCourse(c => c && { ...c, lessons: c.lessons.map(l => (l.id === lesson.id ? { ...l, status: 'done' } : l)) });
    }
  }, [course, lesson]);

  const openPractice = (p: PracticeSummary) => {
    const q = p.runId ? `?run=${encodeURIComponent(p.runId)}` : '';
    navigate(`/learning-center/courses/${encodeURIComponent(courseId)}/practice/${encodeURIComponent(p.id)}${q}`);
  };

  if (error) {
    return (
      <div className="lc-page h-full min-h-0 flex items-center justify-center">
        <div className="lc-surface p-6 max-w-md text-center flex flex-col gap-3 items-center">
          <div className="text-[15px] font-semibold">课程暂时打不开</div>
          <div className="text-[13px] lc-secondary">{error}。你的学习进度已保存在服务端，重新加载即可接着学。</div>
          <Button variant="primary" onClick={() => void load()}><RefreshCw size={15} />重新加载</Button>
        </div>
      </div>
    );
  }
  if (!course || !lesson) return <div className="lc-page h-full min-h-0"><MapSectionLoader text="正在打开课程…" /></div>;

  const done = course.lessons.filter(l => l.status === 'done').length;
  const practicesDone = course.practices.filter(p => p.status === 'done').length;
  const idx = course.lessons.findIndex(l => l.id === lesson.id);
  const prev = course.lessons[idx - 1];
  const next = course.lessons[idx + 1];
  const practice = course.practices.find(p => lesson.practiceIds.includes(p.id)) ?? course.practices[0];

  const rail = (
    <LessonRail
      course={course}
      activeLessonId={lesson.id}
      onPickLesson={l => { pick({ lesson: l.id }); setMobilePane('lesson'); }}
      onPickPractice={openPractice}
    />
  );

  return (
    <div className="lc-page h-full min-h-0 flex flex-col gap-3" data-lc-ready="course">
      {isMobile ? (
        <header className="lc-surface lc-topbar shrink-0" style={{ padding: '4px 6px' }} data-qc-touch-exempt>
          <Link to="/learning-center" className="lc-crumb shrink-0" aria-label="回到学习中心" data-lc="back-center"><ChevronLeft size={16} /></Link>
          <div className="min-w-0 flex-1">
            <SegmentedTabs
              ariaLabel="课程页面切换"
              items={[{ key: 'lesson', label: `第 ${lesson.index} 课` }, { key: 'outline', label: `目录与练习 · ${done}/${course.lessons.length}` }]}
              value={mobilePane}
              onChange={setMobilePane}
            />
          </div>
        </header>
      ) : (
      <header className="lc-surface lc-topbar shrink-0">
        <Link to="/learning-center" className="lc-crumb shrink-0" data-lc="back-center"><ChevronLeft size={15} />学习中心</Link>
        <span className="lc-muted shrink-0" aria-hidden>/</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="text-[15px] font-bold truncate">{course.title}</h1>
            {course.wip && <span className="text-[11px] px-2 py-0.5 rounded-full shrink-0" style={{ border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}>试运行</span>}
          </div>
          <div className="text-[12px] lc-muted truncate hidden sm:block">{course.subtitle}</div>
        </div>
        <div className="hidden sm:flex flex-col gap-1.5 shrink-0" style={{ width: 200 }} data-lc="course-progress">
          <div className="flex items-center justify-between text-[12px]">
            <span className="lc-secondary">已学 {done}/{course.lessons.length} 课</span>
            <span className="lc-muted">练习 {practicesDone}/{course.practices.length}</span>
          </div>
          <div className="lc-progress-track"><div className="lc-progress-fill" style={{ width: `${(done / course.lessons.length) * 100}%` }} /></div>
        </div>
      </header>
      )}

      <div className="flex-1 min-h-0 flex gap-3">
        {(!isMobile || mobilePane === 'outline') && (
          <aside className={`lc-scroll ${isMobile ? 'flex-1' : 'shrink-0'} lc-surface p-2`} style={isMobile ? undefined : { width: 'var(--lc-rail)' }}>
            {rail}
          </aside>
        )}

        {(!isMobile || mobilePane === 'lesson') && (
          <main className={`flex-1 min-w-0 min-h-0 flex flex-col gap-3 ${isMobile ? 'lc-scroll' : ''}`} aria-label={`第 ${lesson.index} 课`}>
            <div className="flex items-end gap-3 flex-wrap shrink-0">
              <div className="min-w-0 flex-1" style={{ minWidth: 240 }}>
                <div className="lc-eyebrow flex items-center gap-2">
                  第 {lesson.index} 课 · 约 {lesson.minutes} 分钟
                  {lesson.status === 'done' && <span className="inline-flex items-center gap-1" style={{ color: 'var(--accent-fg-success)' }}><CheckCircle2 size={12} />已学完</span>}
                </div>
                <h2 className="text-[19px] font-bold leading-snug mt-1">{lesson.title}</h2>
                {!isMobile && <p className="text-[13px] lc-secondary mt-1 line-clamp-2">{lesson.summary}</p>}
              </div>
              <MediaSwitch lesson={lesson} value={media} onChange={m => pick({ media: m })} />
            </div>

            <div className={isMobile ? 'lc-mobile-media' : 'flex-1 min-h-0'} key={`${lesson.id}-${media}`}>
              {media === 'video' && lesson.media.video && (
                <VideoLesson video={lesson.media.video} onProgress={(sec, completed) => void report({ media: 'video', positionSec: sec, completed })} />
              )}
              {media === 'pdf' && lesson.media.pdf && <PdfLesson pdf={lesson.media.pdf} onPage={page => void report({ media: 'pdf', page })} />}
              {media === 'article' && lesson.media.article && <ArticleLesson article={lesson.media.article} onFinished={() => void report({ media: 'article', completed: true })} />}
            </div>

            <footer className={`lc-surface shrink-0 flex items-center gap-3 p-2.5 ${isMobile ? 'sticky bottom-0' : 'flex-wrap'}`} style={isMobile ? { background: 'var(--panel-solid)' } : undefined} data-tour-id="course-practice-cta">
              <div className={isMobile ? 'hidden' : 'flex items-center gap-2'}>
                <Button variant="ghost" disabled={!prev} onClick={() => prev && pick({ lesson: prev.id })} aria-label="上一课"><ArrowLeft size={15} /><span className="hidden lg:inline">上一课</span></Button>
                <Button variant="ghost" disabled={!next} onClick={() => next && pick({ lesson: next.id })} aria-label="下一课"><span className="hidden lg:inline">下一课</span><ArrowRight size={15} /></Button>
              </div>
              <div className="flex-1 min-w-0 flex items-center gap-2.5" style={isMobile ? undefined : { minWidth: 200 }}>
                {practice && (() => {
                  const Icon = SKILL_REGISTRY[practice.skill].icon;
                  return <>
                    <Icon size={16} className="shrink-0" style={{ color: 'var(--accent-primary)' }} />
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold truncate">练一练：{practice.title}</div>
                      <div className="text-[11.5px] lc-muted truncate hidden sm:block">学完这一课可以直接上手 · 约 {practice.minutes} 分钟 · 也能在目录里换一个练习</div>
                    </div>
                  </>;
                })()}
              </div>
              {practice && (
                <Button variant="primary" onClick={() => openPractice(practice)} data-lc="start-practice">
                  {practice.status === 'doing' ? <><RefreshCw size={15} />接着做</> : practice.status === 'done' ? <><GraduationCap size={15} />再做一遍</> : <><FlaskConical size={15} />开始练习</>}
                </Button>
              )}
            </footer>
          </main>
        )}
      </div>
    </div>
  );
}
