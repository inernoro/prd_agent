import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import {
  armContinuityProbe,
  installContinuityProbe,
  readContinuityProbe,
} from '../utils/continuityProbe';

const STORE_ID = 'recording-acceptance-store';
const ENTRY_ID = 'recording-acceptance-entry';
const SESSION_ID = 'recording-acceptance-session';
const TRANSCRIPT_SEGMENTS = Array.from(
  { length: 18 },
  (_, index) => `验收注入第 ${index + 1} 段：录音文字增加时，波形与结束按钮必须始终可见。`,
);
const LONG_TRANSCRIPT = TRANSCRIPT_SEGMENTS.join('');

// 归档状态会按条目创建时间判断是否停滞。夹具必须相对测试启动时间生成，
// 否则固定历史日期会随着时间推移自动落入“等待重试”，让发布门禁自然腐烂。
const fixtureStartedAtMs = Date.now();
const now = new Date(fixtureStartedAtMs).toISOString();
const transcriptUpdatedAt = new Date(fixtureStartedAtMs + 1).toISOString();
const archiveUpdatedAt = new Date(fixtureStartedAtMs + 2).toISOString();
const uploadExpiresAt = new Date(fixtureStartedAtMs + 24 * 60 * 60 * 1000).toISOString();
const fixtureDate = now.slice(0, 10);

const store = {
  id: STORE_ID,
  name: '录音连续性验收库',
  ownerId: 'recording-e2e-user',
  tags: [],
  isPublic: false,
  pinnedEntryIds: [],
  documentCount: 0,
  likeCount: 0,
  viewCount: 0,
  favoriteCount: 0,
  defaultSortMode: 'created-desc',
  createdAt: now,
  updatedAt: now,
};

const pendingEntry = {
  id: ENTRY_ID,
  storeId: STORE_ID,
  isFolder: false,
  title: '录音连续性验收.webm',
  summary: '',
  sourceType: 'upload',
  contentType: 'audio/webm',
  fileSize: 128,
  tags: [],
  metadata: {
    audioArchiveStatus: 'pending',
    recordingUploadSessionId: SESSION_ID,
    liveTranscript: LONG_TRANSCRIPT,
  },
  createdBy: 'recording-e2e-user',
  createdAt: now,
  updatedAt: now,
};

const olderEntry = {
  ...pendingEntry,
  id: 'recording-acceptance-older-entry',
  title: '较早录音.webm',
  metadata: {
    audioArchiveStatus: 'completed',
    liveTranscript: '这是一条较早的录音。',
  },
  createdAt: '2026-07-30T03:45:00.000Z',
  updatedAt: '2026-07-30T03:45:00.000Z',
};

function json(route: Route, data: unknown) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data, error: null }),
  });
}

async function installRecordingBrowserFakes(page: Page) {
  await page.addInitScript(({ segments }) => {
    const transcript = segments.join('');
    const acceptanceWindow = window as typeof window & {
      __recordingAcceptanceLiveEvents?: Array<{
        kind: 'partial' | 'final';
        segmentCount: number;
        at: number;
      }>;
    };
    acceptanceWindow.__recordingAcceptanceLiveEvents = [];
    localStorage.setItem('prd-admin-auth', JSON.stringify({
      state: {
        isAuthenticated: true,
        user: {
          userId: 'recording-e2e-user',
          username: 'recording-e2e-user',
          displayName: '录音验收用户',
          role: 'ADMIN',
        },
        token: 'recording-e2e-token',
        refreshToken: 'recording-e2e-refresh',
        sessionKey: 'recording-e2e-session',
        permissions: ['access', 'document-store.read', 'document-store.write'],
        permissionsLoaded: true,
        isRoot: false,
        menuCatalog: [],
        menuCatalogLoaded: true,
        cdnBaseUrl: '',
        permFingerprint: 'recording-e2e',
      },
      version: 0,
    }));
    sessionStorage.setItem('doc-store-tab', 'mine');

    const fakeStream = {
      getTracks: () => [{ stop: () => undefined }],
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => fakeStream },
    });

    class AcceptanceMediaRecorder {
      static isTypeSupported(candidate: string) { return candidate.includes('webm'); }
      state: 'inactive' | 'recording' | 'paused' = 'inactive';
      mimeType = 'audio/webm';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void | Promise<void>) | null = null;
      timers: number[] = [];

      start() {
        this.state = 'recording';
        [30, 190, 350, 700].forEach((delay, index) => {
          this.timers.push(window.setTimeout(() => {
            this.ondataavailable?.({
              data: new Blob([`recording-acceptance-audio-${index}`], { type: this.mimeType }),
            });
          }, delay));
        });
      }

      stop() {
        this.state = 'inactive';
        this.timers.forEach(timer => window.clearTimeout(timer));
        this.timers = [];
        this.ondataavailable?.({ data: new Blob(['recording-acceptance-tail'], { type: this.mimeType }) });
        window.setTimeout(() => { void this.onstop?.(); }, 0);
      }

      pause() { this.state = 'paused'; }
      resume() { this.state = 'recording'; }
    }

    class AcceptanceWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSING = 2;
      readonly CLOSED = 3;
      readyState = AcceptanceWebSocket.CONNECTING;
      binaryType = 'blob';
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      timers: number[] = [];

      constructor() {
        super();
        window.setTimeout(() => {
          this.readyState = AcceptanceWebSocket.OPEN;
          const openEvent = new Event('open');
          this.onopen?.(openEvent);
          this.dispatchEvent(openEvent);
          [
            { segmentCount: 3, delay: 30 },
            { segmentCount: 6, delay: 110 },
            { segmentCount: 9, delay: 230 },
            { segmentCount: 12, delay: 590 },
            { segmentCount: 15, delay: 750 },
            { segmentCount: 18, delay: 910 },
          ].forEach(({ segmentCount, delay }) => {
            this.timers.push(window.setTimeout(() => {
              if (this.readyState !== AcceptanceWebSocket.OPEN) return;
              acceptanceWindow.__recordingAcceptanceLiveEvents?.push({
                kind: 'partial',
                segmentCount,
                at: performance.now(),
              });
              this.onmessage?.(new MessageEvent('message', {
                data: JSON.stringify({
                  type: 'partial',
                  text: segments.slice(0, segmentCount).join(''),
                  stable: true,
                }),
              }));
            }, delay));
          });
        }, 10);
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data !== 'string' || !data.includes('"finish"')) return;
        acceptanceWindow.__recordingAcceptanceLiveEvents?.push({
          kind: 'final',
          segmentCount: segments.length,
          at: performance.now(),
        });
        this.onmessage?.(new MessageEvent('message', {
          data: JSON.stringify({ type: 'final', text: transcript, stable: true }),
        }));
      }

      close() {
        this.readyState = AcceptanceWebSocket.CLOSED;
        this.timers.forEach(timer => window.clearTimeout(timer));
        this.timers = [];
      }
    }

    class AcceptanceAudio extends EventTarget {
      src = '';
      preload = '';
      paused = true;
      duration = 3;
      currentTime = 0;
      playbackRate = 1;
      setAttribute() { return undefined; }
      removeAttribute() { return undefined; }
      load() {
        window.setTimeout(() => {
          this.dispatchEvent(new Event('loadedmetadata'));
          this.dispatchEvent(new Event('canplay'));
        }, 0);
      }
      play() {
        this.paused = false;
        this.dispatchEvent(new Event('play'));
        return Promise.resolve();
      }
      pause() {
        if (this.paused) return;
        this.paused = true;
        this.dispatchEvent(new Event('pause'));
      }
    }

    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: AcceptanceMediaRecorder });
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: AcceptanceWebSocket });
    Object.defineProperty(window, 'Audio', { configurable: true, value: AcceptanceAudio });
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
    Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: undefined });
  }, { segments: TRANSCRIPT_SEGMENTS });
}

type RecordingFixtureOptions = {
  initiallyCompleted?: boolean;
  completionDelayMs?: number;
  transcriptReadyAfterMs?: number;
  archiveReadyAfterMs?: number;
};

async function installApiFixture(
  page: Page,
  requests: string[],
  {
    initiallyCompleted = false,
    completionDelayMs = 900,
    transcriptReadyAfterMs = 1_200,
    archiveReadyAfterMs = 4_000,
  }: RecordingFixtureOptions = {},
) {
  let recordingCompleted = initiallyCompleted;
  let recordingCompletedAt = initiallyCompleted ? Date.now() - archiveReadyAfterMs - 100 : 0;
  let uploadedBytes = 0;
  const completionAge = () => recordingCompletedAt > 0 ? Date.now() - recordingCompletedAt : 0;
  const transcriptReady = () => completionAge() >= transcriptReadyAfterMs;
  const archiveReady = () => completionAge() >= archiveReadyAfterMs;
  const currentEntry = () => archiveReady()
    ? {
        ...pendingEntry,
        metadata: { ...pendingEntry.metadata, audioArchiveStatus: 'completed' },
        updatedAt: archiveUpdatedAt,
      }
    : transcriptReady()
      ? { ...pendingEntry, updatedAt: transcriptUpdatedAt }
      : pendingEntry;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    requests.push(`${method} ${path}`);

    if (path === '/api/authz/me') {
      return json(route, {
        effectivePermissions: ['access', 'document-store.read', 'document-store.write'],
        menuCatalog: [],
        isRoot: false,
      });
    }
    if (path === '/api/changelog/current-week') {
      return json(route, {
        weekStart: fixtureDate,
        weekEnd: fixtureDate,
        dataSourceAvailable: true,
        source: 'local',
        fetchedAt: now,
        totalDays: 0,
        totalEntries: 0,
        daysOffset: 0,
        hasMore: false,
        fragments: [],
      });
    }
    if (path === '/api/document-store/stores/quick-capture' && method === 'POST') {
      return json(route, store);
    }
    if (path === '/api/document-store/stores/with-preview') {
      return json(route, {
        items: [{
          ...store,
          documentCount: recordingCompleted ? 2 : 0,
          recentEntries: recordingCompleted
            ? [{ id: ENTRY_ID, title: pendingEntry.title, updatedAt: now, contentType: pendingEntry.contentType }]
            : [],
        }],
        total: 1,
        page: 1,
        pageSize: 500,
      });
    }
    if (path === `/api/document-store/stores/${STORE_ID}` && method === 'GET') {
      return json(route, { ...store, documentCount: recordingCompleted ? 2 : 0 });
    }
    if (path === `/api/document-store/stores/${STORE_ID}/entries` && method === 'GET') {
      return json(route, {
        // 故意让服务端返回旧录音在前，验收前端默认排序确实把新录音放到最前。
        items: recordingCompleted ? [olderEntry, currentEntry()] : [],
        sharedEntryIds: [],
        total: recordingCompleted ? 2 : 0,
        page: 1,
        pageSize: 200,
      });
    }
    if (path === `/api/document-store/stores/${STORE_ID}/recording-uploads` && method === 'POST') {
      return json(route, {
        sessionId: SESSION_ID,
        nextChunkIndex: 0,
        uploadedBytes: 0,
        expiresAt: uploadExpiresAt,
      });
    }
    if (path.startsWith(`/api/document-store/recording-uploads/${SESSION_ID}/chunks/`) && method === 'POST') {
      const chunkIndex = Number(path.split('/').at(-1));
      uploadedBytes += 64;
      return json(route, {
        accepted: true,
        duplicate: false,
        nextChunkIndex: chunkIndex + 1,
        uploadedBytes,
      });
    }
    if (path === `/api/document-store/recording-uploads/${SESSION_ID}/complete` && method === 'POST') {
      await new Promise(resolve => setTimeout(resolve, completionDelayMs));
      recordingCompleted = true;
      recordingCompletedAt = Date.now();
      return json(route, {
        entry: pendingEntry,
        attachmentId: null,
        fileUrl: null,
        sessionId: SESSION_ID,
        reused: false,
        archivePending: true,
        audioProtected: true,
        deferredTranscriptionRunId: null,
      });
    }
    if (path === `/api/document-store/recording-uploads/${SESSION_ID}` && method === 'GET') {
      return json(route, {
        sessionId: SESSION_ID,
        status: recordingCompleted ? 'completed' : 'uploading',
        nextChunkIndex: 1,
        uploadedBytes: 128,
        entryId: recordingCompleted ? ENTRY_ID : null,
        archiveStatus: 'pending',
        archiveAttempts: 1,
        archiveError: recordingCompleted && !archiveReady()
          ? '对象存储暂时不可用，已进入后台归档队列'
          : null,
        liveTranscriptStatus: 'completed',
        liveTranscript: LONG_TRANSCRIPT,
        expiresAt: uploadExpiresAt,
      });
    }
    if (path === `/api/document-store/entries/${ENTRY_ID}/recording-archive/retry` && method === 'POST') {
      return json(route, { queued: true, completed: false });
    }
    if (path === `/api/document-store/entries/${ENTRY_ID}/content` && method === 'GET') {
      return json(route, {
        hasContent: false,
        content: null,
        fileUrl: archiveReady() ? '/recording-ready.webm' : null,
        contentType: 'audio/webm',
      });
    }
    if (path === `/api/document-store/entries/${ENTRY_ID}` && method === 'GET') {
      return json(route, currentEntry());
    }
    if (path === `/api/mentions/documents/${ENTRY_ID}/links`) {
      return json(route, {
        entryId: ENTRY_ID,
        backlinks: [],
        forwardLinks: [],
        backlinksCount: 0,
        forwardLinksCount: 0,
      });
    }
    if (path === `/api/document-store/entries/${ENTRY_ID}/inline-comments`) {
      return json(route, {
        items: [],
        canCreate: true,
        isOwner: true,
        viewerUserId: 'recording-e2e-user',
      });
    }
    if (path.includes('/view') && method === 'POST') {
      return json(route, { viewEventId: 'recording-e2e-view' });
    }

    return json(route, {
      items: [],
      total: 0,
      page: 1,
      pageSize: 200,
      unreadCount: 0,
      count: 0,
    });
  });
}

async function attachViewport(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });
}

test.describe('录音连续性发布门禁', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test('长原文不遮挡控制区，结束后直达可播放结果，刷新不发生页面循环', async ({ page }, testInfo) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const apiRequests: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await installContinuityProbe(page, {
      loaderText: '加载文档内容',
      maxHistoryWrites: 40,
    });
    await installRecordingBrowserFakes(page);
    await installApiFixture(page, apiRequests);
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const mobileProfile = await page.evaluate(() => ({
      width: window.innerWidth,
      touchPoints: navigator.maxTouchPoints,
    }));
    expect(mobileProfile.width).toBeLessThanOrEqual(480);
    expect(mobileProfile.touchPoints).toBeGreaterThan(0);

    await page.getByRole('button', { name: '快速创建' }).click();
    const quickRecordAction = page.getByRole('button', { name: /快速录音/ });
    await expect(quickRecordAction).toBeVisible();
    await expect(quickRecordAction).toBeInViewport();
    await expect(quickRecordAction).toContainText('结束后直接查看播放与原文');
    await attachViewport(page, testInfo, '00-quick-create-recording-entry');
    await quickRecordAction.click();

    const recordingTitle = page.getByText('快捷录音').first();
    try {
      await expect(recordingTitle).toBeVisible();
    } catch (error) {
      await testInfo.attach('entry-diagnostics', {
        body: JSON.stringify({
          url: page.url(),
          title: await page.title(),
          body: await page.locator('body').innerText(),
          consoleErrors,
          pageErrors,
        }, null, 2),
        contentType: 'application/json',
      });
      throw new Error(`${String(error)}\n${JSON.stringify({
        url: page.url(),
        title: await page.title(),
        body: await page.locator('body').innerText(),
        consoleErrors,
        pageErrors,
      }, null, 2)}`);
    }
    const transcript = page.getByTestId('recording-live-transcript');
    const waveform = page.getByTestId('recording-waveform');
    const finish = page.getByTestId('recording-finish');
    await expect(transcript).toContainText('验收注入第 3 段');
    await expect(transcript).not.toContainText('验收注入第 18 段');
    await expect(waveform).toBeVisible();
    await expect(finish).toBeInViewport();

    await expect.poll(async () => page.evaluate(() => {
      const acceptanceWindow = window as typeof window & {
        __recordingAcceptanceLiveEvents?: Array<{ kind: string; segmentCount: number }>;
      };
      return acceptanceWindow.__recordingAcceptanceLiveEvents
        ?.filter(event => event.kind === 'partial')
        .at(-1)?.segmentCount ?? 0;
    })).toBe(9);
    await expect(transcript).toContainText('验收注入第 9 段');
    await expect(transcript).not.toContainText('验收注入第 18 段');
    await expect(waveform).toBeVisible();
    await expect(finish).toBeInViewport();

    await expect(transcript).toContainText('验收注入第 18 段', { timeout: 2_000 });
    const liveEventsBeforeFinish = await page.evaluate(() => {
      const acceptanceWindow = window as typeof window & {
        __recordingAcceptanceLiveEvents?: Array<{
          kind: 'partial' | 'final';
          segmentCount: number;
          at: number;
        }>;
      };
      return acceptanceWindow.__recordingAcceptanceLiveEvents ?? [];
    });
    expect(liveEventsBeforeFinish.filter(event => event.kind === 'partial').map(event => event.segmentCount))
      .toEqual([3, 6, 9, 12, 15, 18]);
    expect(liveEventsBeforeFinish.filter(event => event.kind === 'final')).toHaveLength(0);
    expect(liveEventsBeforeFinish.at(-1)!.at).toBeGreaterThan(liveEventsBeforeFinish[0].at);

    const layout = await transcript.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(layout.clientHeight).toBeLessThanOrEqual(121);
    expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
    await attachViewport(page, testInfo, '01-recording-controls-visible');

    // 等待首个 MediaRecorder 分片真实进入写入队列，确保完成动作覆盖落盘竞态。
    await page.waitForTimeout(80);
    await finish.click();
    const finalizingStartedAt = Date.now();
    await page.getByRole('button', { name: '仍要转成文字' }).click();
    const finalizingPanel = page.getByTestId('recording-finalizing-panel');
    await expect(finalizingPanel).toBeVisible();
    const firstFeedbackMs = Date.now() - finalizingStartedAt;
    expect(firstFeedbackMs).toBeLessThan(2_000);
    await expect(finalizingPanel).toContainText('正在创建录音结果');
    await expect(finalizingPanel).toContainText('最多前台等待 45 秒');
    await attachViewport(page, testInfo, '02-finalizing-progress');

    await expect.poll(() => {
      const url = new URL(page.url());
      return `${url.searchParams.get('store')}:${url.searchParams.get('entry')}`;
    }).toBe(`${STORE_ID}:${ENTRY_ID}`);
    if (await page.getByText('页面渲染出错').count()) {
      throw new Error(JSON.stringify({ consoleErrors, pageErrors, apiRequests }, null, 2));
    }
    const backgroundProgress = page.getByTestId('recording-background-progress');
    await expect(backgroundProgress).toBeVisible();
    await expect(backgroundProgress).toContainText('后台只负责保存正式音频并确认原文可恢复，不会自动总结或改写');
    await expect(backgroundProgress).toContainText('完成后本页自动更新，可以离开本页');
    await backgroundProgress.scrollIntoViewIfNeeded();
    await attachViewport(page, testInfo, '03-background-progress');
    const playToggle = page.getByTestId('audio-play-toggle');
    await expect(playToggle).toBeVisible();
    await expect(playToggle).toBeEnabled();
    const firstUsableResultMs = Date.now() - finalizingStartedAt;
    expect(firstUsableResultMs).toBeLessThan(4_000);
    await expect(page.getByText('智能估算跟随，可点句跳播')).toBeVisible();
    await playToggle.click();
    await expect(playToggle).toHaveAttribute('title', '暂停');
    await expect(page.getByText('暂无可预览的内容')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '原文', exact: true })).toHaveCount(0);
    await armContinuityProbe(page);
    const transcriptLines = page.locator('button[title="点击跳到这一句"]');
    await expect(transcriptLines).toHaveCount(18);
    const lastTranscriptLine = transcriptLines.nth(17);
    const backlinksHint = page.getByText('还没有文档引用这篇', { exact: false });
    await expect(lastTranscriptLine).toContainText('验收注入第 18 段');
    await expect(backlinksHint).toBeVisible();
    const transcriptBox = await lastTranscriptLine.boundingBox();
    const backlinksBox = await backlinksHint.boundingBox();
    expect(transcriptBox).not.toBeNull();
    expect(backlinksBox).not.toBeNull();
    expect(backlinksBox!.y).toBeGreaterThanOrEqual(transcriptBox!.y + transcriptBox!.height - 1);
    await attachViewport(page, testInfo, '04-recording-local-playback');
    await backlinksHint.scrollIntoViewIfNeeded();
    await attachViewport(page, testInfo, '05-transcript-footer-separated');

    await expect(backgroundProgress).toContainText('云端服务暂时不可用，已排队重试');
    await expect(backgroundProgress).toContainText('不需要停在本页等待');
    const manualRetry = page.getByRole('button', { name: '立即重试' });
    await expect(manualRetry).toBeVisible();
    await manualRetry.click();
    await expect.poll(() => apiRequests.filter(request => (
      request === `POST /api/document-store/entries/${ENTRY_ID}/recording-archive/retry`
    )).length).toBe(1);
    await backgroundProgress.scrollIntoViewIfNeeded();
    await attachViewport(page, testInfo, '05b-cloud-retry-is-non-blocking');
    const beforeManualReload = await readContinuityProbe(page);
    expect(beforeManualReload.documentBootCount).toBe(1);
    expect(beforeManualReload.beforeUnloadCount).toBe(0);
    expect(beforeManualReload.contentLoaderAppearances).toBe(0);
    await testInfo.attach('recording-continuity-metrics-before-reload', {
      body: JSON.stringify({
        evidenceProvenance: 'deterministic-fixture',
        taskIdentity: { storeId: STORE_ID, entryId: ENTRY_ID, sessionId: SESSION_ID },
        firstFeedbackMs,
        firstUsableResultMs,
        ...beforeManualReload,
      }, null, 2),
      contentType: 'application/json',
    });

    await expect(backgroundProgress).toHaveCount(0, { timeout: 8_000 });
    await expect(page.getByText('云端副本已保存', { exact: true })).toBeVisible();
    const stableUrl = page.url();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('audio-play-toggle')).toBeEnabled();
    await expect(page.getByTestId('recording-background-progress')).toHaveCount(0);
    await page.waitForTimeout(1_200);
    expect(page.url()).toBe(stableUrl);
    const afterManualReload = await readContinuityProbe(page);
    expect(afterManualReload.documentBootCount).toBe(2);
    expect(afterManualReload.beforeUnloadCount).toBe(1);
    expect(afterManualReload.replaceStateCount).toBeLessThan(20);
    await testInfo.attach('recording-continuity-metrics-after-reload', {
      body: JSON.stringify({
        evidenceProvenance: 'deterministic-fixture',
        taskIdentity: { storeId: STORE_ID, entryId: ENTRY_ID, sessionId: SESSION_ID },
        ...afterManualReload,
      }, null, 2),
      contentType: 'application/json',
    });
    await attachViewport(page, testInfo, '06-recording-refresh-stable');

    const criticalErrors = [...consoleErrors, ...pageErrors].filter(message => (
      /replaceState|maximum update depth|页面渲染出错|render error/i.test(message)
    ));
    expect(criticalErrors, criticalErrors.join('\n')).toHaveLength(0);
    await testInfo.attach('recording-requirement-coverage', {
      body: JSON.stringify({
        evidenceProvenance: 'deterministic-fixture',
        requirements: [
          { id: 'recording-entry', result: 'pass', evidence: '快速创建首屏可见快速录音入口' },
          { id: 'long-transcript-layout', result: 'pass', evidence: '18 段原文滚动且波形、结束按钮仍在视口' },
          {
            id: 'live-transcript-midpoint-continuity',
            result: 'pass',
            evidence: {
              partialSegmentCounts: liveEventsBeforeFinish
                .filter(event => event.kind === 'partial')
                .map(event => event.segmentCount),
              finalEventsBeforeFinish: liveEventsBeforeFinish.filter(event => event.kind === 'final').length,
            },
          },
          { id: 'finish-to-result', result: 'pass', evidence: '结束后 URL 保持同一 storeId 与 entryId' },
          { id: 'first-feedback', result: 'pass', evidence: { firstFeedbackMs, limitMs: 2_000 } },
          { id: 'first-usable-result', result: 'pass', evidence: { firstUsableResultMs, limitMs: 4_000 } },
          { id: 'local-playback', result: 'pass', evidence: '云端归档期间播放器可用且能进入暂停态' },
          { id: 'single-content-mode', result: 'pass', evidence: '仅有原文时不存在名为原文的单独按钮' },
          { id: 'failure-degradation', result: 'pass', evidence: '云端失败时已有播放与原文保留，并说明自动重试' },
          { id: 'manual-retry', result: 'pass', evidence: '立即重试按钮可见且只发起一次归档重试请求' },
          { id: 'recovery-in-place', result: 'pass', evidence: '恢复时内容加载层出现 0 次，页面未离开' },
          { id: 'refresh-restore', result: 'pass', evidence: '手动刷新后 URL 与任务身份不变，无 history 循环' },
        ],
      }, null, 2),
      contentType: 'application/json',
    });
  });
});

test.describe('录音结果返回上下文门禁', () => {
  test.use({
    viewport: { width: 1280, height: 800 },
    isMobile: false,
    hasTouch: false,
  });

  test('从录音正文返回列表后，新录音排第一并保留来源高光', async ({ page }, testInfo) => {
    const requests: string[] = [];
    await installContinuityProbe(page, {
      loaderText: '加载文档内容',
      maxHistoryWrites: 40,
    });
    await installRecordingBrowserFakes(page);
    await installApiFixture(page, requests, { initiallyCompleted: true });
    await page.goto(`/document-store?store=${STORE_ID}&entry=${ENTRY_ID}`, { waitUntil: 'domcontentloaded' });

    await expect.poll(() => {
      const url = new URL(page.url());
      return `${url.searchParams.get('store')}:${url.searchParams.get('entry')}`;
    }).toBe(`${STORE_ID}:${ENTRY_ID}`);
    await expect(page.getByTestId('audio-play-toggle')).toBeEnabled();
    await expect(page.getByRole('button', { name: '原文', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: '返回列表', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('entry')).toBeNull();

    const recordingRow = page.locator(`button[data-entry-id="${ENTRY_ID}"]`);
    await expect(recordingRow).toBeVisible();
    const visibleEntryIds = await page.locator('button[data-entry-id]').evaluateAll(
      rows => rows.map(row => row.getAttribute('data-entry-id')),
    );
    expect(visibleEntryIds[0]).toBe(ENTRY_ID);

    const returnHighlight = await recordingRow.evaluate(element => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        boxShadow: style.boxShadow,
      };
    });
    const ordinaryRowStyle = await page
      .locator(`button[data-entry-id="${olderEntry.id}"]`)
      .evaluate(element => {
        const style = getComputedStyle(element);
        return {
          backgroundColor: style.backgroundColor,
          boxShadow: style.boxShadow,
        };
      });
    // 验证“来源行有高光”这一产品语义，不把某个主题经过颜色混合后的 RGB 写死。
    expect(returnHighlight.backgroundColor).not.toBe(ordinaryRowStyle.backgroundColor);
    expect(returnHighlight.boxShadow).not.toBe(ordinaryRowStyle.boxShadow);
    expect(returnHighlight.boxShadow).not.toBe('none');

    await testInfo.attach('recording-return-context', {
      body: JSON.stringify({
        evidenceProvenance: 'deterministic-fixture',
        taskIdentity: { storeId: STORE_ID, entryId: ENTRY_ID, sessionId: SESSION_ID },
        serverOrder: [olderEntry.id, ENTRY_ID],
        renderedOrder: visibleEntryIds,
        returnHighlight,
        ordinaryRowStyle,
        requestedPaths: requests,
      }, null, 2),
      contentType: 'application/json',
    });
    await attachViewport(page, testInfo, '07-recording-return-context');
  });
});
