import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 「重新生成」回来之后，面板显示的来源标签必须用后端回的那个值。
 *
 * 这次点击未必真写进去了：别人在这几秒里把题库改成手写，后端会回 Superseded 加上库里
 * 最新的 questionsSource='manual'。这里如果硬标成 'auto'，面板就把别人手写的那份说成
 * 「系统读正文生成」——而这个标签下面还配着一句「你改过之后就不再被自动覆盖」的解释，
 * 会引着人再点一次把那份冲掉。
 *
 * 这条接线删掉之后没有任何用例会红（改的只是一个展示字段），所以用源码守卫钉住。
 */
describe('提问配置抽屉的来源标签', () => {
  const src = fs.readFileSync(
    path.join(__dirname, 'AskConfigDrawer.tsx'),
    'utf8',
  );

  it('重新生成之后不许把来源写死成 auto', () => {
    expect(src).not.toMatch(/setQuestionsSource\(\s*'auto'\s*\)/);
  });

  it('必须消费后端回的 questionsSource', () => {
    expect(src).toContain("res.data?.questionsSource === 'manual'");
  });
});
