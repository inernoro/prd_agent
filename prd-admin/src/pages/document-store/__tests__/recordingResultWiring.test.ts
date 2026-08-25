/**
 * 录音结果页接线守卫。
 *
 * 这条链有四环：注册路由 → 页面给回调 → 阅读器往下传 → 状态卡当主操作用。
 * 每一环单独删掉，编译过、全量测试绿、页面也不报错——只是那一屏再也进不去了
 * （predicate-and-wiring-discipline 形状 2：只建一半，静默退化）。
 * 所以这里按**行为意图**扫源码，不逐字比对实现：断言的是「这一环还在」，
 * 不是「这一行长这个样」，改写法不该让守卫误红（形状 4a）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/** 路由模板：页面、注册表、跳转三处必须说同一个路径，散着写就会各自漂移。 */
const ROUTE_SEGMENTS = ['/document-store/', '/recording/'];

describe('录音结果页的四环接线', () => {
  it('第一环：注册表登记了结果页路由，且指向 RecordingResultPage', () => {
    const registry = read('app/navRegistry.tsx');
    const route = registry
      .split('\n')
      .find(line => ROUTE_SEGMENTS.every(seg => line.includes(seg)) && line.includes('path:'));
    expect(route, '注册表里找不到录音结果页的路由').toBeTruthy();
    // 路由里必须带上这两个参数，否则页面拿不到该开哪一条录音
    expect(route).toContain(':storeId');
    expect(route).toContain(':entryId');
    expect(registry).toContain('<RecordingResultPage />');
  });

  it('第二环：知识库页把跳转回调传给阅读器，并跳到同一个路由', () => {
    const page = read('pages/document-store/DocumentStorePage.tsx');
    expect(page).toContain('onOpenRecordingResult=');
    const navLine = page
      .split('\n')
      .find(line => line.includes('navigate(') && ROUTE_SEGMENTS.every(seg => line.includes(seg)));
    expect(navLine, '知识库页没有跳到录音结果页').toBeTruthy();
    // 设计稿这一下是「进入结果页并开始播放」，跳转与起播是同一个动作
    expect(navLine).toContain('play=1');
  });

  it('第三环：阅读器把回调接到状态卡的主操作上，而不是自己吞掉', () => {
    const browser = read('components/doc-browser/DocBrowser.tsx');
    expect(browser).toContain('onOpenRecordingResult?:');
    expect(browser).toMatch(/onEnterResult=\{onOpenRecordingResult/);
  });

  it('第四环：状态卡用它当主操作，且没有结果页可去时文案退回就地播放', () => {
    const card = read('components/doc-browser/TranscribeStatusCard.tsx');
    expect(card).toContain('onEnterResult');
    expect(card).toContain('进入结果页并开始播放');
    // 降级路径必须还在：分享只读页没有结果页可跳，按钮文案要跟着变
    expect(card).toContain('立即播放这段录音');
  });

  it('结果页认 play=1 并且用完就擦掉（刷新不该自己响一遍）', () => {
    const resultPage = read('pages/document-store/RecordingResultPage.tsx');
    expect(resultPage).toContain("get('play')");
    expect(resultPage).toContain('requestRecordingPlay');
    expect(resultPage).toMatch(/delete\('play'\)/);
  });

  it('结果页有返回出口（独立全屏页最容易出的是进得来出不去）', () => {
    const resultPage = read('pages/document-store/RecordingResultPage.tsx');
    expect(resultPage).toContain('aria-label="返回"');
    expect(resultPage).toContain('navigate(-1)');
  });
});
