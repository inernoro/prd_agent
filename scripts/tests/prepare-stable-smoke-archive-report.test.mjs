import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareArchiveReport } from '../prepare-stable-smoke-archive-report.mjs';

test('归档版按模块生成步骤并用不可变证据占位替换本地图片', () => {
  const report = `# 报告

## 视觉证据图片

![旧本地图片](</tmp/old.png>)

## 视觉测试方法

逐状态核对。`;
  const manifest = [
    { name: '001-login', module: '登录', primaryState: '入口', status: '通过', breadcrumb: '登录 → 首页 → 头像', caption: '入口可见', runId: 'stsmk-test', commit: 'a'.repeat(40) },
    { name: '002-result', module: '登录', primaryState: '结果', status: '通过', breadcrumb: '登录 → 首页 → 头像 → 结果', caption: '结果可见', runId: 'stsmk-test', commit: 'a'.repeat(40) },
    { name: '003-file', module: '文件', primaryState: '上传', status: '不通过', breadcrumb: '首页 → 文件 → 上传', caption: '上传失败', runId: 'stsmk-test', commit: 'a'.repeat(40) },
  ];
  const output = prepareArchiveReport(report, manifest);
  assert.match(output, /## 步骤 1 登录/);
  assert.match(output, /## 步骤 2 文件/);
  assert.match(output, /## 验收用例/);
  assert.ok(output.includes(`固定测试版本：\`${'a'.repeat(40)}\``));
  assert.ok(output.includes('运行编号：`stsmk-test`'));
  assert.match(output, /\| 1 \| 登录 \| 冒烟、功能与视觉/);
  assert.match(output, /\[图001\]\(#fig-001\)/);
  assert.match(output, /\| 2 \| 文件 .*\| 不通过 \| 是 \|/);
  assert.match(output, /\{\{IMG:001-login\}\}/);
  assert.match(output, /\{\{IMG:003-file\}\}/);
  assert.doesNotMatch(output, /\/tmp\/old\.png/);
  assert.match(output, /## 视觉测试方法/);
});

test('已有验收用例章节时不重复生成', () => {
  const report = `# 报告\n\n## 验收用例\n\n已有用例说明。\n\n## 视觉证据图片\n\n旧图片\n\n## 视觉测试方法\n\n方法`;
  const manifest = [{ name: '001-entry', module: '登录', primaryState: '入口', status: '通过' }];
  const archived = prepareArchiveReport(report, manifest);
  assert.equal((archived.match(/## 验收用例/g) || []).length, 1);
});

test('归档版把历史截图别名统一到唯一图号', () => {
  const report = `# 报告\n\n[图024](#fig-024-recording-real-transcription-failure)\n\n## 视觉证据图片\n\n旧图片\n\n## 视觉测试方法\n\n方法`;
  const manifest = [{ name: 'recording-24', module: '录音', primaryState: '失败恢复', status: '需补证' }];
  const archived = prepareArchiveReport(report, manifest);
  assert.match(archived, /\[图024\]\(#fig-024\)/);
  assert.doesNotMatch(archived, /fig-024-recording-real-transcription-failure/);
});

test('正式环境只读报告声明零视觉任务时允许空清单', () => {
  const report = `# 正式环境只读报告

## 逐模块视觉取证任务

本轮无视觉取证任务。原因：正式环境单独运行仅执行只读健康检查，不进入需要截图取证的业务创作页面。需要完整视觉结论时，执行 CDS 或双环境全量稳定冒烟。

## 视觉异常证据索引

本轮没有可列出的视觉异常证据。`;
  assert.equal(prepareArchiveReport(report, []), report);
});

test('空清单没有正式只读零视觉声明时仍拒绝归档', () => {
  const report = `# 不完整报告

## 逐模块视觉取证任务

本轮没有截图。`;
  assert.throws(
    () => prepareArchiveReport(report, []),
    /缺少“视觉证据图片”或“视觉测试方法”章节/,
  );
});

test('非空清单缺少标准视觉章节时仍拒绝归档', () => {
  const report = `# 错误报告

## 逐模块视觉取证任务

本轮无视觉取证任务。原因：正式环境单独运行仅执行只读健康检查。`;
  assert.throws(
    () => prepareArchiveReport(report, [{ name: '001-entry', module: '登录' }]),
    /缺少“视觉证据图片”或“视觉测试方法”章节/,
  );
});
