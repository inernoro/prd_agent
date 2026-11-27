import { apiRequest } from '@/services/real/apiClient';
import type { ApiResponse } from '@/types/api';
import type { Course, CourseSummary, Decision, LessonMediaKind, Practice, PracticeRun } from '@/pages/learning-course/types';

/* 课程与练习接口。全部走 apiRequest：以 success 判断，错误取 error.message。
 * 练习的评审与复测由服务端 Run 执行（离开页面不取消），前端按 runId 轮询。 */

const base = '/api/learning';

export function listCourses(): Promise<ApiResponse<{ items: CourseSummary[] }>> {
  return apiRequest(`${base}/courses`);
}

export function getCourse(courseId: string): Promise<ApiResponse<Course>> {
  return apiRequest(`${base}/courses/${encodeURIComponent(courseId)}`);
}

/** 记录学习位置：视频秒数、PDF 页码或图文读完；completed=true 标记本课学完 */
export function saveLessonProgress(courseId: string, lessonId: string, body: { media: LessonMediaKind; positionSec?: number; page?: number; completed?: boolean }) {
  return apiRequest<{ status: 'done' | 'current' }>(`${base}/courses/${encodeURIComponent(courseId)}/lessons/${encodeURIComponent(lessonId)}/progress`, { method: 'PUT', body });
}

export function getPractice(courseId: string, practiceId: string): Promise<ApiResponse<Practice>> {
  return apiRequest(`${base}/courses/${encodeURIComponent(courseId)}/practices/${encodeURIComponent(practiceId)}`);
}

export function startPracticeRun(courseId: string, practiceId: string): Promise<ApiResponse<PracticeRun>> {
  return apiRequest(`${base}/practice-runs`, { method: 'POST', body: { courseId, practiceId } });
}

export function getPracticeRun(runId: string): Promise<ApiResponse<PracticeRun>> {
  return apiRequest(`${base}/practice-runs/${encodeURIComponent(runId)}`);
}

/** 让 Agent 开始评审（或在失败后重试评审） */
export function runPracticeReview(runId: string): Promise<ApiResponse<PracticeRun>> {
  return apiRequest(`${base}/practice-runs/${encodeURIComponent(runId)}/review`, { method: 'POST', body: {} });
}

/** 提交逐条判断：服务端应用被采纳的修复并开始复测 */
export function submitPracticeDecisions(runId: string, decisions: Record<string, Decision>, reasons: Record<string, string>): Promise<ApiResponse<PracticeRun>> {
  return apiRequest(`${base}/practice-runs/${encodeURIComponent(runId)}/decisions`, { method: 'POST', body: { decisions, reasons } });
}

/** 复测没通过时回到判断这一步，保留已作的判断 */
export function reopenPracticeTriage(runId: string): Promise<ApiResponse<PracticeRun>> {
  return apiRequest(`${base}/practice-runs/${encodeURIComponent(runId)}/reopen`, { method: 'POST', body: {} });
}

export function submitPracticeDelivery(runId: string, note: string): Promise<ApiResponse<PracticeRun>> {
  return apiRequest(`${base}/practice-runs/${encodeURIComponent(runId)}/delivery`, { method: 'POST', body: { note } });
}
