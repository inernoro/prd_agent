/* 课程与练习的数据契约（与 services/real/learningCourses.ts 的接口一一对应）。
 * 业务判定（练习的对错、复测结果、经验值）全部由服务端给出，前端只展示。 */

export type LessonMediaKind = 'video' | 'pdf' | 'article';
export type LessonStatus = 'done' | 'current' | 'todo';
export type PracticeSkill = 'review' | 'visual' | 'unit' | 'integration';

export interface CourseSummary {
  id: string;
  title: string;
  subtitle: string;
  lessonCount: number;
  /** 每课的短名，课程卡的迷你路线用 */
  lessonShortTitles: string[];
  minutes: number;
  level: string;
  /** 试运行：真人验收前为 true，学习中心课程卡显示「试运行」 */
  wip?: boolean;
  coverUrl?: string;
  progress: { lessonsDone: number; practicesDone: number; nextLessonId?: string; nextLessonTitle?: string };
}

export interface VideoChapter { atSec: number; title: string }
export interface TranscriptLine { atSec: number; text: string }

export interface VideoMedia {
  url: string;
  posterUrl?: string;
  durationSec: number;
  chapters: VideoChapter[];
  transcript: TranscriptLine[];
  /** 上次看到的位置，服务端保存 */
  resumeAtSec?: number;
}

export interface PdfMedia {
  title: string;
  /** 原文件，供下载 */
  url: string;
  sizeLabel: string;
  /** 逐页图（服务端在上传时生成），手机与桌面显示一致 */
  pages: { imageUrl: string; title: string }[];
  /** 本课对应的页码区间（从 1 开始，含两端） */
  lessonRange: [number, number];
  lastPage?: number;
}

export type ArticleBlock =
  | { type: 'h2'; id: string; text: string }
  | { type: 'p'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'code'; lang: string; code: string; caption?: string }
  | { type: 'callout'; tone: 'tip' | 'warn'; title: string; text: string }
  | { type: 'figure'; imageUrl: string; caption: string };

export interface ArticleMedia { readMinutes: number; blocks: ArticleBlock[] }

export interface Lesson {
  id: string;
  index: number;
  title: string;
  summary: string;
  /** 本课要点，三条以内，伴读栏常驻 */
  keyPoints: string[];
  minutes: number;
  status: LessonStatus;
  media: { video?: VideoMedia; pdf?: PdfMedia; article?: ArticleMedia };
  /** 没有某种材料时的原因，按材料类型给出（例如本课没有视频，图文已覆盖） */
  missingReason?: Partial<Record<LessonMediaKind, string>>;
  practiceIds: string[];
}

export interface PracticeSummary {
  id: string;
  title: string;
  skill: PracticeSkill;
  minutes: number;
  summary: string;
  lessonIds: string[];
  status: 'todo' | 'doing' | 'done';
  /** 进行中时，回来能续上 */
  runId?: string;
}

export interface Course {
  id: string;
  title: string;
  subtitle: string;
  wip?: boolean;
  outcomes: string[];
  lessons: Lesson[];
  practices: PracticeSummary[];
}

/* ---------------- 练习 ---------------- */

export interface CodeFile { path: string; lang: string; lines: string[] }

export type PracticeSubject =
  | { kind: 'code'; files: CodeFile[] }
  | { kind: 'visual'; baselineUrl: string; actualUrl: string; viewport: string; theme: string };

export interface Practice {
  id: string;
  courseId: string;
  title: string;
  skill: PracticeSkill;
  minutes: number;
  scenario: string;
  /** 交付时要满足的条件 */
  acceptance: string[];
  /** 你要练的判断 */
  focus: string;
  agentLabel: string;
  subject: PracticeSubject;
}

export type FindingSeverity = 'P0' | 'P1' | 'P2';

export interface Finding {
  id: string;
  severity: FindingSeverity;
  title: string;
  /** 代码类：文件与行号；视觉类：截图上的区域（百分比） */
  location: { file?: string; line?: number; region?: { x: number; y: number; w: number; h: number } };
  evidence: string;
  suggestion: string;
  /** 采纳后要应用的修复（代码类为 diff 行） */
  fix?: string[];
}

export type RunStageStatus = 'waiting' | 'running' | 'done' | 'failed';

export interface AgentRun {
  id: string;
  purpose: 'review' | 'retest';
  status: 'queued' | 'running' | 'done' | 'failed';
  stages: { key: string; label: string; status: RunStageStatus; detail?: string }[];
  progress: number;
  elapsedSec: number;
  remainSec?: number;
  estimateBasis: string;
  /** 来自网关返回，不在前端写死 */
  model?: { model: string; platform: string };
  failure?: { message: string; retryable: boolean };
}

export type Decision = 'accept' | 'reject';

export interface RetestResult {
  passed: boolean;
  checks: { name: string; status: 'pass' | 'fail'; message?: string }[];
  /** 判断出错时，逐条告诉学员错在哪 */
  feedback: { findingId: string; message: string }[];
  summary: string;
}

export interface PracticeRun {
  id: string;
  practiceId: string;
  step: 'brief' | 'review' | 'triage' | 'retest' | 'deliver' | 'done';
  attempt: number;
  run?: AgentRun;
  findings: Finding[];
  decisions: Record<string, Decision>;
  reasons: Record<string, string>;
  retest?: RetestResult;
  delivery?: { note: string; submittedAt?: string };
  /** 服务端按本次判断与复测生成的交付说明草稿 */
  deliveryDraft?: string;
  outcome?: { xp: number; timeline: { at: string; text: string }[] };
}
