/**
 * Mock 数据 — 用于「一键预览」功能
 * 让用户看到配置完善后周报系统的完整效果
 */
import type { CollectedActivity } from '@/services/contracts/reportAgent';

export const MOCK_ACTIVITY: CollectedActivity = {
  userId: 'mock-user',
  periodStart: new Date(Date.now() - 7 * 86400000).toISOString(),
  periodEnd: new Date().toISOString(),
  // 核心指标
  prdSessions: 8,
  prdMessageCount: 47,
  defectsSubmitted: 5,
  visualSessions: 3,
  llmCalls: 126,
  imageGenCompletedCount: 12,
  videoGenCompletedCount: 2,
  documentEditCount: 4,
  workflowExecutionCount: 7,
  toolboxRunCount: 15,
  webPagePublishCount: 1,
  attachmentUploadCount: 9,
  defectDetails: {
    submitted: 5,
    resolved: 3,
    reopened: 1,
    avgResolutionHours: 4.2,
  },
  // 每日打点
  dailyLogs: [
    {
      id: 'mock-dl-1', userId: 'mock-user', date: getMockDate(0),
      items: [
        { category: 'dev', content: '完成用户画像 API 开发', durationMinutes: 120 },
        { category: 'meeting', content: '产品需求评审会议', durationMinutes: 60 },
      ],
      createdAt: getMockDate(0), updatedAt: getMockDate(0),
    },
    {
      id: 'mock-dl-2', userId: 'mock-user', date: getMockDate(1),
      items: [
        { category: 'dev', content: '修复图表渲染性能问题', durationMinutes: 90 },
        { category: 'docs', content: '编写 API 接口文档', durationMinutes: 45 },
        { category: 'comms', content: '与前端同步联调方案', durationMinutes: 30 },
      ],
      createdAt: getMockDate(1), updatedAt: getMockDate(1),
    },
    {
      id: 'mock-dl-3', userId: 'mock-user', date: getMockDate(2),
      items: [
        { category: 'dev', content: '重构数据聚合模块', durationMinutes: 180 },
        { category: 'test', content: '补充集成测试用例', durationMinutes: 60 },
      ],
      createdAt: getMockDate(2), updatedAt: getMockDate(2),
    },
    {
      id: 'mock-dl-4', userId: 'mock-user', date: getMockDate(3),
      items: [
        { category: 'dev', content: '实现周报自动生成 MVP', durationMinutes: 150 },
        { category: 'meeting', content: '代码评审', durationMinutes: 45 },
      ],
      createdAt: getMockDate(3), updatedAt: getMockDate(3),
    },
    {
      id: 'mock-dl-5', userId: 'mock-user', date: getMockDate(4),
      items: [
        { category: 'dev', content: '联调部署上线', durationMinutes: 120 },
        { category: 'docs', content: '更新技术文档和变更日志', durationMinutes: 60 },
      ],
      createdAt: getMockDate(4), updatedAt: getMockDate(4),
    },
  ],
  // Git 提交
  commits: [
    mockCommit('feat: 实现用户画像 API 核心逻辑', 0, 156, 23),
    mockCommit('fix: 修复图表在大数据量下的渲染卡顿', 1, 42, 18),
    mockCommit('docs: 更新 API 接口文档 v2.1', 1, 87, 12),
    mockCommit('refactor: 抽取数据聚合通用模块', 2, 203, 145),
    mockCommit('test: 补充聚合模块集成测试', 2, 89, 3),
    mockCommit('feat: 周报自动生成 MVP 版本', 3, 312, 47),
    mockCommit('fix: 修复周报模板解析边界情况', 3, 15, 8),
    mockCommit('chore: 联调环境配置更新', 4, 8, 4),
    mockCommit('feat: 周报预览与导出功能', 4, 134, 22),
    mockCommit('docs: 更新 CHANGELOG', 4, 45, 2),
  ],
};

export const MOCK_REPORT_SECTIONS = [
  {
    templateSection: { title: '本周完成', description: '本周主要完成的工作', inputType: 'BulletList', isRequired: true },
    items: [
      { content: '完成用户画像 API 开发和联调 (+156/-23 行代码)', source: 'git' },
      { content: '修复图表大数据量渲染性能问题，FCP 降低 40%', source: 'git' },
      { content: '重构数据聚合模块，提取通用组件减少重复代码 30%', source: 'git' },
      { content: '实现周报自动生成 MVP，支持 AI 智能填充', source: 'git' },
    ],
  },
  {
    templateSection: { title: '下周计划', description: '下周的工作计划', inputType: 'BulletList', isRequired: true },
    items: [
      { content: '用户画像功能灰度发布与监控', source: 'ai' },
      { content: '启动数据可视化 v2 方案设计', source: 'ai' },
      { content: '完善自动化测试覆盖率到 80%', source: 'ai' },
    ],
  },
  {
    templateSection: { title: '风险与阻塞', description: '当前面临的风险和阻塞项', inputType: 'BulletList', isRequired: false },
    items: [
      { content: '第三方数据源 API 偶发超时，需要增加重试机制', source: 'ai' },
    ],
  },
];

function getMockDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - (4 - daysAgo)); // Mon=0, Tue=1, ...
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function mockCommit(message: string, dayIdx: number, additions: number, deletions: number) {
  const d = new Date();
  d.setDate(d.getDate() - (4 - dayIdx));
  d.setHours(10 + Math.floor(Math.random() * 8), Math.floor(Math.random() * 60));
  const sha = Math.random().toString(36).slice(2, 10);
  return {
    id: `mock-commit-${dayIdx}-${additions}`,
    dataSourceId: 'mock-ds',
    repoName: 'prd-agent',
    branch: 'main',
    sha,
    commitHash: sha,
    message,
    authorName: 'Mock User',
    authorEmail: 'mock@example.com',
    committedAt: d.toISOString(),
    additions,
    deletions,
    filesChanged: Math.max(1, Math.floor((additions + deletions) / 20)),
    mappedUserId: 'mock-user',
    createdAt: d.toISOString(),
  };
}
