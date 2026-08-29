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
  /**
   * 每片上传的往返延迟。默认 0（片一发出去就算传上去了，两种判据在桩里完全重合，
   * 于是「承诺不许反复进出」那条断言无论实现怎么写都绿）。
   * 布局门禁把它调到一片的产生间隔以上，让「本机已存」在大部分时刻领先「已上传」一片，
   * 与真机同形：迟滞判据稳定为真，瞬时判据每秒翻一次。
   */
  chunkLatencyMs?: number;
  transcriptReadyAfterMs?: number;
  archiveReadyAfterMs?: number;
  /**
   * 云端归档什么时候算完成。
   *
   * `time`：按 `archiveReadyAfterMs` 的时间窗（第二条门禁只要「已经归档好」这个终态，
   * 时间窗最省事）。
   * `retry`：**只有用户点了「立即重试」才完成**。第一条门禁断言的是一整条用户故事——
   * 云端暂时不可用 → 页面照常可用 → 点立即重试 → 云端副本已保存。用时间窗表达它是错的：
   * 那句「云端服务暂时不可用」的断言排在两张整屏截图、一次点击和 18 行原文断言之后，
   * 机器稍慢窗口就已经自己关上，门禁红在计时器而不是产品行为上
   * （predicate-and-wiring-discipline 形状 1：判据认的不是它要守的那件事）。
   */
  archiveReadyOn?: 'time' | 'retry';
};

async function installApiFixture(
  page: Page,
  requests: string[],
  {
    initiallyCompleted = false,
    completionDelayMs = 900,
    chunkLatencyMs = 0,
    transcriptReadyAfterMs = 1_200,
    archiveReadyAfterMs = 4_000,
    archiveReadyOn = 'time',
  }: RecordingFixtureOptions = {},
) {
  let recordingCompleted = initiallyCompleted;
  let recordingCompletedAt = initiallyCompleted ? Date.now() - archiveReadyAfterMs - 100 : 0;
  let uploadedBytes = 0;
  const completionAge = () => recordingCompletedAt > 0 ? Date.now() - recordingCompletedAt : 0;
  const transcriptReady = () => completionAge() >= transcriptReadyAfterMs;
  /*
   * 点了重试之后留一小段「已排队、还没好」：这一小段正是 05b 那张证据要拍的东西
   * （重试不阻塞本页）。立刻转成完成的话，卡片在截图之前就没了。
   */
  const ARCHIVE_SETTLE_AFTER_RETRY_MS = 1_500;
  let archiveRetriedAt = 0;
  const archiveReady = () => (archiveReadyOn === 'retry'
    ? archiveRetriedAt > 0 && Date.now() - archiveRetriedAt >= ARCHIVE_SETTLE_AFTER_RETRY_MS
    : completionAge() >= archiveReadyAfterMs);
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
      /*
       * 收多少就记多少：此前每片固定记 64 字节，于是「已上传」永远远远落后于「本机已存」，
       * 那句续传承诺在桩里从头到尾不出现——布局门禁里那条「承诺不许反复进出」的断言
       * 因此永远绿，连把判据改回瞬时比较都照绿（形状 8：拿一份不成立的证据当证明）。
       * 按真实体积累计之后，桩里的上传是「追平 → 落后一片 → 再追平」，
       * 与真机同形：迟滞判据稳定为真，瞬时判据每秒翻一次。
       */
      const chunkBytes = route.request().postDataBuffer()?.byteLength ?? 64;
      if (chunkLatencyMs > 0) await new Promise(resolve => setTimeout(resolve, chunkLatencyMs));
      uploadedBytes += chunkBytes;
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
      // 归档在 retry 模式下**只有这一下**能让它完成，对应真实链路里「重试被受理」
      if (archiveRetriedAt === 0) archiveRetriedAt = Date.now();
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
    /*
     * 这条门禁要走完「云端暂时不可用 → 点立即重试 → 云端副本已保存」，
     * 所以归档只认重试这一下，不认计时器（见 archiveReadyOn 的说明）。
     */
    await installApiFixture(page, apiRequests, { archiveReadyOn: 'retry' });
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

    /*
     * 「采集面板打开了」这件事要按**行为**断言，不能盯着一句文案。
     * 这里原本断言的是面板标题那四个字（当时叫「快捷录音」），设计稿把它改成
     * 「录音转笔记」之后这道门就红了——门里守的东西一点没坏，坏的是判据
     * （predicate-and-wiring-discipline 形状 4a：断言某段实现的字面存在）。
     * 改成认面板自己的 testid：计时器与「结束录音」都在，就说明它真的开起来了。
     */
    const recordingElapsed = page.getByTestId('recording-elapsed');
    try {
      await expect(recordingElapsed).toBeVisible();
      await expect(page.getByTestId('recording-finish')).toBeVisible();
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
    /*
     * 这一段守的是「实时原文是**逐段长出来**的，不是跑完一次性全量出现」，
     * 顺带守住长原文不遮挡波形与结束键。
     *
     * 但判据不能去采样「此刻恰好是第几段」：桩把六批 partial 排在 30~910ms 内推完，
     * 而测试自己走到这里要花更久，于是「最后一批 == 9」在慢机器上永远等不到
     * （CI 实测 Expected 9 / Received 18），「此刻还没有第 18 段」同理
     * （predicate-and-wiring-discipline 形状 1：判据钉的是一个正在动的中间值）。
     *
     * 逐段增长这件事有一个**确定**的判据：所有 partial 事件都被记下来了，
     * 下面 `liveEventsBeforeFinish` 断言的正是完整序列 [3,6,9,12,15,18]。
     * 所以这里只等「已经长到第 9 段这一档」，把「有没有分批」交给那条序列断言。
     */
    await expect(transcript).toContainText('验收注入第 3 段');
    await expect(waveform).toBeVisible();
    await expect(finish).toBeInViewport();

    await expect.poll(async () => page.evaluate(() => {
      const acceptanceWindow = window as typeof window & {
        __recordingAcceptanceLiveEvents?: Array<{ kind: string; segmentCount: number }>;
      };
      return acceptanceWindow.__recordingAcceptanceLiveEvents
        ?.filter(event => event.kind === 'partial')
        .at(-1)?.segmentCount ?? 0;
    })).toBeGreaterThanOrEqual(9);
    await expect(transcript).toContainText('验收注入第 9 段');
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
    /*
     * 这道门守的是「长原文不把控制区顶出去」，判据在上面两行已经落地：波形可见、
     * 「结束录音」在视口内。这里再加一层，防的是原文区**按内容长**——真发生回归时
     * 它会长到上千像素。
     *
     * 但界限不能钉一个像素快照：原来写死的 121 是当时那版布局的实测值，
     * 采集屏按设计稿重排（卡片改为按剩余空间分配、波形高度分档）之后它变成 133，
     * 控制区一点没被挡住，门却红了——判据盯的是某一版实现的字面尺寸，不是它要守的
     * 那件事（predicate-and-wiring-discipline 形状 4a）。改成按视口比例：
     * 占到四分之一屏就说明它在按内容长，而正常布局远在这条线以下。
     */
    const viewportHeight = page.viewportSize()!.height;
    expect(layout.clientHeight).toBeLessThanOrEqual(Math.round(viewportHeight * 0.25));
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
    /*
     * 「首个可用结果」要量的是**产品**的时间，所以在取证动作之前就量。
     * 它此前排在「后台进度卡断言 + 滚动 + 整屏截图」之后，那两步是 Playwright 自己的
     * 开销（截一张整屏在受限机器上要几百毫秒），机器一忙就把这个数推过 4 秒，
     * 红的是取证成本、不是用户等待。判据本身一点没放松：仍然是 4 秒、仍然要求
     * 播放键可见且可用。
     */
    const playToggle = page
      .getByTestId('audio-play-toggle')
      .or(page.getByTestId('recording-segment-play'))
      .first();
    await expect(playToggle).toBeVisible();
    await expect(playToggle).toBeEnabled();
    const firstUsableResultMs = Date.now() - finalizingStartedAt;
    expect(firstUsableResultMs).toBeLessThan(4_000);

    const backgroundProgress = page.getByTestId('recording-background-progress');
    await expect(backgroundProgress).toBeVisible();
    await expect(backgroundProgress).toContainText('后台只负责保存正式音频并确认原文可恢复，不会自动总结或改写');
    await expect(backgroundProgress).toContainText('完成后本页自动更新，可以离开本页');
    /*
     * 这一下只是为了把卡片滚进截图，断言在上面两行已经做完了。
     * 而这张卡在云端副本存完的那一刻**本来就会消失**（archivePending 转 false），
     * 它和这次滚动是同一秒的事——撞上就抛「元素已从 DOM 移除」，让一条本来通过的
     * 门禁红在取证动作上。滚不动就算了，证据截图照常出。
     */
    await backgroundProgress.scrollIntoViewIfNeeded({ timeout: 1_000 }).catch(() => undefined);
    await attachViewport(page, testInfo, '03-background-progress');
    /*
     * 「可播放」有两种形态：展开的播放器，或滚过它之后那条迷你片段条——两者都带播放键，
     * 承诺（结束后直达可播放结果）由**任意一个**兑现。这里此前只认展开态那颗，
     * 于是上面 scrollIntoView 把播放区滚收起来之后，门禁就误判成「还不能播」
     * （predicate-and-wiring-discipline 形状 1：判据比它该管的范围窄）。
     */
    /*
     * 这里守的是「这条时间轴是估算出来的，界面要说出来」。原来钉的是那一整句文案
     * （「智能估算跟随，可点句跳播」），设计稿把它改成「智能估算时间轴 · 可能有偏差」
     * 之后这道门就红了，而它要守的那件事一点没变。改成认「估算」这个语义词。
     * 句中另一半承诺（可点句跳播）在下面几行有自己的断言：
     * `button[title="点击跳到这一句"]` 恰好 18 条，所以这里不重复钉文案。
     */
    await expect(page.getByText('估算', { exact: false }).first()).toBeVisible();
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
    // 与上面那次同理：这一下只为把卡片滚进截图，而它随时可能因为归档转好而消失
    await backgroundProgress.scrollIntoViewIfNeeded({ timeout: 1_000 }).catch(() => undefined);
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
    // 同上：收起态下播放键在迷你片段条上，两者任一可用即算「这条录音现在能播」
    await expect(page
      .getByTestId('audio-play-toggle')
      .or(page.getByTestId('recording-segment-play'))
      .first()).toBeEnabled();
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

/*
 * 布局稳定性门禁。
 *
 * 为什么要单独一条：设计稿还原那套取证是「录几秒 → 截一张静帧」，而用户报的那个抖动
 * 只存在于**两帧之间**——每一帧单看都正常、都贴稿，静态比对在原理上看不见它。
 * 40 块画板判到 99 分也照样漏。
 *
 * 判据只有一句：录音进行中，采集屏上几个地标的纵向位置**不许动**。
 * 这里不采样「此刻长什么样」，而是采样一段时间里的位置集合——位置只要出现过两个值，
 * 就是抖了（predicate-and-wiring-discipline 形状 1：别去钉一个正在动的中间值）。
 */
test.describe('采集屏布局稳定性门禁', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('录音期间波形与凭据行不上下跳', async ({ page }, testInfo) => {
    const apiRequests: string[] = [];
    await installRecordingBrowserFakes(page);
    await installApiFixture(page, apiRequests, { chunkLatencyMs: 1_400 });
    await page.goto(`/document-store?store=${STORE_ID}&record=1`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('recording-elapsed')).toBeVisible({ timeout: 20_000 });

    /*
     * 先等抽屉的入场动效落定，再开始量。
     * 这一屏是滑上来的：`recording-elapsed` 可见的那一刻动画还在跑，第一帧可能截在半路，
     * 于是量到几百 px 的「位移」——那不是录音期间的抖动，是取证起点没站稳
     * （本轮这道门就这么随机红过一次：1089 / 442 / 421，后两个是动画尾巴）。
     * 判据是「连续两次读到同一个位置」，且必须在 5 秒内落定；落不定就直接判失败，
     * 不许悄悄跳过——一个会空跑的门禁比没有门禁更糟。
     */
    const readWaveTop = () => page.evaluate(() => {
      const wave = document.querySelector('[data-testid="recording-waveform"]');
      return wave ? Math.round(wave.getBoundingClientRect().top) : -1;
    });
    let settledTop = -1;
    let lastTop = await readWaveTop();
    const settleDeadline = Date.now() + 5_000;
    while (Date.now() < settleDeadline) {
      await page.waitForTimeout(120);
      const top = await readWaveTop();
      if (top > 0 && top === lastTop) { settledTop = top; break; }
      lastTop = top;
    }
    expect(settledTop, '抽屉入场 5 秒内没有落定，后面的采样不成立').toBeGreaterThan(0);

    const SAMPLE_MS = 9_000;
    const samples: Array<{ t: number; wave: number; chipsHeight: number; label: string; promise: boolean; uploadH: number; micText: string; micH: number }> = [];
    const started = Date.now();
    while (Date.now() - started < SAMPLE_MS) {
      samples.push({
        t: Date.now() - started,
        ...(await page.evaluate(() => {
          const chips = document.querySelector('[data-testid="recording-guard-chips"]');
          const wave = document.querySelector('[data-testid="recording-waveform"]');
          const upload = document.querySelector('[data-testid="recording-upload-progress"]');
          return {
            wave: wave ? Math.round(wave.getBoundingClientRect().top) : -1,
            chipsHeight: chips ? Math.round(chips.getBoundingClientRect().height) : -1,
            label: chips ? (chips as HTMLElement).innerText.replace(/\s+/g, ' ') : '',
            // 那句承诺在不在——它以前挂在瞬时比较上，每秒进出一次
            promise: upload ? (upload as HTMLElement).innerText.includes('新片段会接着传') : false,
            uploadH: upload ? Math.round(upload.getBoundingClientRect().height) : -1,
            micText: (document.querySelector('[data-testid="recording-mic-health"]') as HTMLElement | null)?.innerText ?? '',
            micH: Math.round(document.querySelector('[data-testid="recording-mic-health"]')?.getBoundingClientRect().height ?? -1),
          };
        })),
      });
      await page.waitForTimeout(200);
    }

    const waveTops = [...new Set(samples.map((s) => s.wave))];
    const chipsHeights = [...new Set(samples.map((s) => s.chipsHeight))];
    await testInfo.attach('layout-stability', {
      body: JSON.stringify({ samples: samples.length, waveTops, chipsHeights, raw: samples }, null, 2),
      contentType: 'application/json',
    });

    // 采样本身要有效：地标必须真的找到了，且采到了足够多帧
    expect(samples.length).toBeGreaterThan(20);
    expect(waveTops.every((top) => top > 0)).toBe(true);

    /*
     * 幅度判据，不是「只许一个值」。留 1px 是因为分数像素取整——布局本身没动，
     * 相邻两帧的 getBoundingClientRect 也可能一个 421.4、一个 421.6，取整就差 1。
     * 这个余量不会放过任何一类真问题：用户报的那次是 18px（一整行），
     * 跟读吸顶条那类是 10px，滚动留白那类是 92px。
     * 行数变化则一像素都不留：凭据行的高度由行数决定，多一行就是多 30px。
     */
    const waveSpread = Math.max(...waveTops) - Math.min(...waveTops);
    expect(waveSpread, `波形顶部在 ${SAMPLE_MS}ms 内移动了 ${waveSpread}px：${waveTops.join(' / ')}`)
      .toBeLessThanOrEqual(1);
    expect(chipsHeights, `凭据行高度变过：${chipsHeights.join(' / ')}`).toHaveLength(1);

    /*
     * 再加一条**认行为**的：那句「录音还在继续，新片段会接着传」在录音期间不许一会儿
     * 出现一会儿消失。像素判据在这个桩里只体现为 2px（桩的分片是几十字节，那句话短到
     * 不换行），真机上是一整行 18px——判据不该依赖桩恰好把幅度放大到多少。
     */
    const promiseStates = [...new Set(samples.map((s) => s.promise))];
    // 断的是「一直在」，不只是「一直没变」：桩里如果那句话从头到尾不出现，
    // 「没变过」同样成立，判据就退化成永远绿（形状 8）。
    expect(promiseStates, '那句承诺在录音期间反复进出（每秒翻一次）').toEqual([true]);
  });
});
