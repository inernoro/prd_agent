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
    { name: '001-login', module: '登录', primaryState: '入口', status: '通过', breadcrumb: '登录 → 首页 → 头像', caption: '入口可见' },
    { name: '002-result', module: '登录', primaryState: '结果', status: '通过', breadcrumb: '登录 → 首页 → 头像 → 结果', caption: '结果可见' },
    { name: '003-file', module: '文件', primaryState: '上传', status: '不通过', breadcrumb: '首页 → 文件 → 上传', caption: '上传失败' },
  ];
  const output = prepareArchiveReport(report, manifest);
  assert.match(output, /## 步骤 1 登录/);
  assert.match(output, /## 步骤 2 文件/);
  assert.match(output, /\{\{IMG:001-login\}\}/);
  assert.match(output, /\{\{IMG:003-file\}\}/);
  assert.doesNotMatch(output, /\/tmp\/old\.png/);
  assert.match(output, /## 视觉测试方法/);
});

test('归档版把历史截图别名统一到唯一图号', () => {
  const report = `# 报告\n\n[图024](#fig-024-recording-real-transcription-failure)\n\n## 视觉证据图片\n\n旧图片\n\n## 视觉测试方法\n\n方法`;
  const manifest = [{ name: 'recording-24', module: '录音', primaryState: '失败恢复', status: '需补证' }];
  const archived = prepareArchiveReport(report, manifest);
  assert.match(archived, /\[图024\]\(#fig-024\)/);
  assert.doesNotMatch(archived, /fig-024-recording-real-transcription-failure/);
});
