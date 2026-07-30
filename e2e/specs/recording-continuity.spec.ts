import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';

const STORE_ID = 'recording-acceptance-store';
const ENTRY_ID = 'recording-acceptance-entry';
const SESSION_ID = 'recording-acceptance-session';
const LONG_TRANSCRIPT = Array.from(
  { length: 18 },
  (_, index) => `验收注入第 ${index + 1} 段：录音文字增加时，波形与结束按钮必须始终可见。`,
).join('');

const now = '2026-07-31T03:45:00.000Z';

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

function json(route: Route, data: unknown) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data, error: null }),
  });
}

async function installRecordingBrowserFakes(page: Page) {
  await page.addInitScript(({ transcript }) => {
    const acceptanceWindow = window as typeof window & {
      __recordingAcceptance: { replaceStateCalls: number };
    };
    acceptanceWindow.__recordingAcceptance = { replaceStateCalls: 0 };
    const originalReplaceState = history.replaceState.bind(history);
    history.replaceState = (...args: Parameters<History['replaceState']>) => {
      acceptanceWindow.__recordingAcceptance.replaceStateCalls += 1;
      if (acceptanceWindow.__recordingAcceptance.replaceStateCalls > 40) {
        throw new Error('录音详情发生 history.replaceState 循环');
      }
      return originalReplaceState(...args);
    };

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

      start() {
        this.state = 'recording';
        window.setTimeout(() => {
          this.ondataavailable?.({ data: new Blob(['recording-acceptance-audio'], { type: this.mimeType }) });
        }, 30);
      }

      stop() {
        this.state = 'inactive';
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

      constructor() {
        super();
        window.setTimeout(() => {
          this.readyState = AcceptanceWebSocket.OPEN;
          const openEvent = new Event('open');
          this.onopen?.(openEvent);
          this.dispatchEvent(openEvent);
          this.onmessage?.(new MessageEvent('message', {
            data: JSON.stringify({ type: 'partial', text: transcript, stable: true }),
          }));
        }, 10);
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data !== 'string' || !data.includes('"finish"')) return;
        this.onmessage?.(new MessageEvent('message', {
          data: JSON.stringify({ type: 'final', text: transcript, stable: true }),
        }));
      }

      close() {
        this.readyState = AcceptanceWebSocket.CLOSED;
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
  }, { transcript: LONG_TRANSCRIPT });
}

async function installApiFixture(page: Page, requests: string[]) {
  let recordingCompleted = false;
  let recordingCompletedAt = 0;
  let uploadedBytes = 0;
  const archiveReady = () => recordingCompletedAt > 0 && Date.now() - recordingCompletedAt >= 1_500;
  const currentEntry = () => archiveReady()
    ? {
        ...pendingEntry,
        metadata: { ...pendingEntry.metadata, audioArchiveStatus: 'completed' },
        updatedAt: '2026-07-31T03:46:00.000Z',
      }
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
        weekStart: '2026-07-31',
        weekEnd: '2026-07-31',
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
          documentCount: recordingCompleted ? 1 : 0,
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
      return json(route, { ...store, documentCount: recordingCompleted ? 1 : 0 });
    }
    if (path === `/api/document-store/stores/${STORE_ID}/entries` && method === 'GET') {
      return json(route, {
        items: recordingCompleted ? [currentEntry()] : [],
        sharedEntryIds: [],
        total: recordingCompleted ? 1 : 0,
        page: 1,
        pageSize: 200,
      });
    }
    if (path === `/api/document-store/stores/${STORE_ID}/recording-uploads` && method === 'POST') {
      return json(route, {
        sessionId: SESSION_ID,
        nextChunkIndex: 0,
        uploadedBytes: 0,
        expiresAt: '2026-08-01T03:45:00.000Z',
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
      await new Promise(resolve => setTimeout(resolve, 900));
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
        liveTranscriptStatus: 'completed',
        liveTranscript: LONG_TRANSCRIPT,
        expiresAt: '2026-08-01T03:45:00.000Z',
      });
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

    await installRecordingBrowserFakes(page);
    await installApiFixture(page, apiRequests);
    await page.goto('/document-store?quickRecord=1', { waitUntil: 'domcontentloaded' });

    const mobileProfile = await page.evaluate(() => ({
      width: window.innerWidth,
      touchPoints: navigator.maxTouchPoints,
    }));
    expect(mobileProfile.width).toBeLessThanOrEqual(480);
    expect(mobileProfile.touchPoints).toBeGreaterThan(0);

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
    await expect(transcript).toContainText('验收注入第 18 段');
    await expect(waveform).toBeVisible();
    await expect(finish).toBeInViewport();

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
    await page.getByRole('button', { name: '仍要转成文字' }).click();
    const finalizingPanel = page.getByTestId('recording-finalizing-panel');
    await expect(finalizingPanel).toBeVisible();
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
    await expect(backgroundProgress).toContainText('预计几分钟内完成，可以离开本页');
    await backgroundProgress.scrollIntoViewIfNeeded();
    await attachViewport(page, testInfo, '03-background-progress');
    const playToggle = page.getByTestId('audio-play-toggle');
    await expect(playToggle).toBeVisible();
    await expect(playToggle).toBeEnabled();
    await expect(page.getByText('智能估算跟随，可点句跳播')).toBeVisible();
    await playToggle.click();
    await expect(playToggle).toHaveAttribute('title', '暂停');
    await expect(page.getByText('暂无可预览的内容')).toHaveCount(0);
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

    await expect(backgroundProgress).toHaveCount(0, { timeout: 8_000 });
    await expect(page.getByText('云端副本已保存', { exact: true })).toBeVisible();
    const stableUrl = page.url();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('audio-play-toggle')).toBeEnabled();
    await expect(page.getByTestId('recording-background-progress')).toHaveCount(0);
    await page.waitForTimeout(1_200);
    expect(page.url()).toBe(stableUrl);
    const replaceStateCalls = await page.evaluate(() => (
      window as typeof window & { __recordingAcceptance: { replaceStateCalls: number } }
    ).__recordingAcceptance.replaceStateCalls);
    expect(replaceStateCalls).toBeLessThan(20);
    await attachViewport(page, testInfo, '06-recording-refresh-stable');

    const criticalErrors = [...consoleErrors, ...pageErrors].filter(message => (
      /replaceState|maximum update depth|页面渲染出错|render error/i.test(message)
    ));
    expect(criticalErrors, criticalErrors.join('\n')).toHaveLength(0);
  });
});
