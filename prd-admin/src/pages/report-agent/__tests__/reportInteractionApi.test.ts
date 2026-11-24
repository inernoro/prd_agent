import { describe, expect, it, vi } from 'vitest';

// 每个服务函数换成带名字的桩，断言注册表把种类映射到了哪一个
vi.mock('@/services', () => {
  const names = [
    'listComments', 'createComment', 'updateComment', 'deleteComment', 'uploadReportCommentImage',
    'listReportLikes', 'likeReport', 'unlikeReport',
    'listMonthlyComments', 'createMonthlyComment', 'updateMonthlyComment', 'deleteMonthlyComment',
    'uploadMonthlyCommentImage', 'listMonthlyLikes', 'likeMonthlyReport', 'unlikeMonthlyReport',
  ];
  return Object.fromEntries(names.map((n) => [n, Object.assign(() => n, { stubName: n })]));
});

const { getReportInteractionApi } = await import('../reportInteractionApi');

const nameOf = (fn: unknown) => (fn as { stubName: string }).stubName;

describe('reportInteractionApi 注册表', () => {
  it('不传种类时仍是周报原来那套接口（周报详情页零改动的前提）', () => {
    const api = getReportInteractionApi();
    expect(Object.fromEntries(Object.entries(api).map(([k, v]) => [k, nameOf(v)]))).toEqual({
      listComments: 'listComments',
      createComment: 'createComment',
      updateComment: 'updateComment',
      deleteComment: 'deleteComment',
      uploadCommentImage: 'uploadReportCommentImage',
      listLikes: 'listReportLikes',
      like: 'likeReport',
      unlike: 'unlikeReport',
    });
  });

  it('月报的每一项都走月报接口，不会漏一个打到周报上', () => {
    const api = getReportInteractionApi('monthly');
    for (const [key, fn] of Object.entries(api)) {
      expect(nameOf(fn), key).toMatch(/Monthly/);
    }
  });
});
