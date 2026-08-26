/**
 * 在**真实应用**里把录音这条链路的每个状态截出来——不是对照台。
 *
 * 为什么必须有这一份：此前判分用的是 `mock.html` 对照台，那里的画板是手搭的，
 * 绕过了 React Router、`RecordingResultPage` 本身、数据加载、路由守卫和 AppShell。
 * 于是「组件长得对」不等于「用户打开那一屏长得对」——用户实测「和设计稿完全不同」
 * 正是这两者的差。这份脚本走真实入口：
 *
 *   真实 index.html → 真实路由表 → RequireAuth/RequirePermission → RecordingResultPage
 *   → 真实的 getDocumentEntry / getDocumentContent / getDocumentStoreReal → TranscriptKaraoke
 *
 * **只有 HTTP 响应是桩**（沙箱里没有能登录预览站的凭据，见看板「取证的边界」一节）。
 * 所以这份图能证明的是「真实路由与真实页面组件渲染出来是什么样」，
 * **不能**证明真实后端数据下也一样——那一层仍缺凭据，如实记着，不含糊过去。
 *
 * 稿面画的多半是「做过一个动作之后」或「后端那样回的时候」，所以这里有两套驱动：
 *   - **场景**（scenes.json）：改写桩的应答，把页面驱到失败 / 重试 / 离线 / 缺数据等状态
 *   - **驱动**（DRIVERS）：模拟真人操作，输词、点发送、点整理卡、点波形起播
 * 驱不到的状态要**明说驱不到**，不能默认它成立（closed-loop-acceptance）。
 *
 * 跑法：
 *   node e2e/design-fidelity/shoot-real-app.mjs               # 全部场景
 *   SCENES=result,fail-manual node e2e/design-fidelity/...     # 只跑指定场景
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.env.OUT_DIR
  || '/tmp/claude-0/-home-user-prd-agent/e94f0ca4-fb88-51cb-95f1-831ce61d00ee/scratchpad/real-app';
fs.mkdirSync(OUT, { recursive: true });

const BASE = process.env.APP_BASE || 'http://localhost:8123';
const STORE_ID = 'store-demo';
const AUDIO_ID = 'entry-audio';
const NOTE_ID = 'entry-note';

/** 24:18 —— 与顶栏副标题写的时长同一个数（对照台踩过这个坑：两处时长互相矛盾） */
const DURATION_SEC = 24 * 60 + 18;

/** 与对照台同一份样本，两边比的才是同一段内容 */
const NOTE_MD = fs.readFileSync(
  path.resolve(process.cwd(), 'e2e/design-fidelity/fixtures/recording-note.md'),
  'utf8',
);

/**
 * 场景（scene）——把这一屏驱到设计稿画的那个**状态**。
 *
 * 稿面 40 块里有一半以上是状态卡：转录失败、自动重试中、离线、没有说话人、
 * 没有词云……它们在真实页面上都存在，只是要「后端那样回」才会出现。
 * 所以桩不能只有一份定值，要能按场景改写。
 *
 * 一个 scene 就是一份补丁（字段见 scenes.json 的注释条目）：
 *   - `rules`：[{ match: 正则源码, data }] 或 { match, status, message }，
 *     按声明顺序**先于**默认链匹配，所以能覆盖任何默认应答
 *   - `noteMd`：换掉转录笔记正文（驱「没有说话人 / 没有整理结果 / 只有半篇原文」）
 *   - `audioMeta` / `noteMeta`：并进条目 metadata
 *   - `drive`：跑哪一套真人操作（见 DRIVERS）
 *   - `url`：不写就是独立全屏结果页
 *
 * 场景清单与脚本分开放，加一个状态不该动取证逻辑。
 */
const SCENES = JSON.parse(fs.readFileSync(
  path.resolve(process.cwd(), 'e2e/design-fidelity/scenes.json'), 'utf8',
));
const ONLY = process.env.SCENES ? process.env.SCENES.split(',').map(s => s.trim()).filter(Boolean) : null;
const ACTIVE = SCENES.filter(s => !ONLY || ONLY.includes(s.id));
if (ACTIVE.length === 0) throw new Error(`没有匹配的场景：${process.env.SCENES}（可用：${SCENES.map(s => s.id).join(', ')}）`);

/**
 * 假后端：只应答这一屏真正会打的那几个接口。
 * 认不出的 `/api/*` 一律回一个空的成功信封——**不能回 401**：
 * 401 会让 apiRequest 触发 logout + 跳 /login，那样截到的是登录页，不是要判的那一屏。
 */
function buildInit(scene) {
  return `
(() => {
  const STORE_ID = ${JSON.stringify(STORE_ID)};
  const AUDIO_ID = ${JSON.stringify(AUDIO_ID)};
  const NOTE_ID  = ${JSON.stringify(NOTE_ID)};
  const NOTE_MD  = ${JSON.stringify(scene.noteMd ?? NOTE_MD)};
  const DURATION_SEC = ${DURATION_SEC};
  const SCENE = ${JSON.stringify(scene)};

  // 1) 先坐上登录态：真实路由守卫要 isAuthenticated + permissions
  try {
    localStorage.setItem('prd-admin-auth', JSON.stringify({
      state: {
        isAuthenticated: true,
        user: { userId: 'u-demo', username: 'demo', displayName: '演示账号' },
        token: 'stub-token',
        refreshToken: 'stub-refresh',
        sessionKey: 'stub-session',
        permissions: ['access', 'document-store.read', 'document-store.write'],
        permissionsLoaded: true,
        isRoot: false,
        cdnBaseUrl: '',
        permFingerprint: '',
      },
      version: 0,
    }));
  } catch { /* 无痕窗口等场景：拿不到就让守卫按未登录处理，截图会明确显示登录页 */ }

  // 2) 一段可播的静音 WAV，长度就是稿面写的 24:18
  function silentWavUrl(seconds) {
    const rate = 8000, frames = rate * seconds;
    const buf = new ArrayBuffer(44 + frames), view = new DataView(buf);
    const ascii = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    ascii(0, 'RIFF'); view.setUint32(4, 36 + frames, true); ascii(8, 'WAVEfmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate, true);
    view.setUint16(32, 1, true); view.setUint16(34, 8, true);
    ascii(36, 'data'); view.setUint32(40, frames, true);
    for (let i = 0; i < frames; i++) view.setUint8(44 + i, 128);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }
  const audioUrl = silentWavUrl(DURATION_SEC);

  const audioEntry = {
    id: AUDIO_ID, storeId: STORE_ID, title: '用户访谈 · 留存与导入',
    contentType: 'audio/mp4', fileSize: 20027801, tags: [],
    // 整理方式盖在音频条目上：没有它，「一键整理」四张卡全都只能显示「点击生成」——
    // 那是页面**如实**的「不知道」，但和稿面画的「已生成 · 12s 前」对不上，
    // 于是判分把桩的缺口记成了实现的缺失。真实数据里这个字段是有的，桩就得有。
    metadata: Object.assign(
      { transcribe_entry_id: NOTE_ID, transcribe_style_key: 'general' },
      SCENE.audioMeta || {},
    ),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const noteEntry = {
    id: NOTE_ID, storeId: STORE_ID, title: '用户访谈 · 留存与导入（转录笔记）',
    contentType: 'text/markdown', tags: [],
    metadata: Object.assign({ source_entry_id: AUDIO_ID, transcribe_style_key: 'general' }, SCENE.noteMeta || {}),
    createdAt: new Date().toISOString(),
    // 「已生成 · 12s 前」那行相对时间读的就是这个
    updatedAt: new Date(Date.now() - 12_000).toISOString(),
  };

  const STYLES = { items: [
    { key: 'general',   label: '智能摘要', description: '一段话概述 + 要点，识别到结论/待办时单独列出（默认）' },
    { key: 'meeting',   label: '会议纪要', description: '提炼议题、观点、结论和待办，可直接发送或继续编辑' },
    { key: 'todo',      label: '待办清单', description: '只提取行动项，输出可勾选的待办列表' },
    { key: 'interview', label: '访谈整理', description: '按问答对整理，保留关键原话，适合访谈/用户调研' },
    { key: 'custom',    label: '自定义',   description: '自己描述想要的整理方式' },
  ] };

  // 信封必须三键齐全：apiClient 认 success/data/error 同在，少一个就退化成「非契约响应」
  const env = (data) => new Response(JSON.stringify({ success: true, data, error: null }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
  const fail = (status, message) => new Response(
    JSON.stringify({ success: false, data: null, error: { message: message || '请求失败' } }),
    { status: status, headers: { 'Content-Type': 'application/json' } });

  /*
   * 「问这场录音」走的是 SSE 直连对话。桩必须真的推一串 text 事件，
   * 否则那一屏永远停在空输入框——稿面 B4 画的是**答完之后**：结论 + 引用原文。
   * 推的内容照着稿面那一问，措辞由本桩给定，不代表真实模型会这么答。
   */
  // 引用只写 [mm:ss] 标记，不把原句再抄一遍——组件会按标记把那一句提成引用卡；
  // 抄一遍的话正文里会多出一条和卡片重复的句子（那是桩写歪了，不是实现的毛病）。
  const ANSWER = '解析等待 40 秒且全程没有进度反馈，被用户判断为卡死。[09:58]';
  // 问到原文里没有的东西时，模型被要求如实说「无法从录音确认」——
  // 稿面 B4 顶部那条琥珀提示要的就是这一刻，所以桩也得能演出这一刻。
  const NO_ANSWER = '无法从录音确认：这段访谈里没有提到价格。';
  function sseAnswer(body) {
    const text = /价格|报价/.test(String(body ?? '')) ? NO_ANSWER : ANSWER;
    const parts = text.match(/[\\s\\S]{1,12}/g) ?? [];
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode('event: start\\ndata: {"model":"stub","platform":"stub"}\\n\\n'));
        let i = 0;
        const push = () => {
          if (i < parts.length) {
            controller.enqueue(enc.encode('event: text\\ndata: ' + JSON.stringify({ content: parts[i++] }) + '\\n\\n'));
            setTimeout(push, 20);
            return;
          }
          controller.enqueue(enc.encode('event: done\\ndata: {}\\n\\n'));
          controller.close();
        };
        setTimeout(push, 20);
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!/\\/api\\//.test(url)) return real(input, init);

    // 场景规则先于默认链：它要能覆盖任何一条默认应答，否则驱不到失败/重试/离线
    for (const rule of (SCENE.rules || [])) {
      if (!new RegExp(rule.match).test(url)) continue;
      if (rule.status && rule.status >= 400) return Promise.resolve(fail(rule.status, rule.message));
      if (rule.reject) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(env(rule.data));
    }

    if (url.includes('/ai-toolbox/direct-chat')) return Promise.resolve(sseAnswer(init && init.body));
    // 点一张整理卡 → 真实页面发起 run 并开始轮询；桩让它停在「生成中 40%」，
    // 稿面 B3 画的就是这一刻（一张已生成 + 一张在跑）
    // 用行尾锚定而不是 includes：「/transcribe-styles」里也含「/transcribe」，
    // 顺序一换就会把清单请求吞掉，网格整块消失（形状 1：判据太宽）
    if (/\\/transcribe(\\?|$)/.test(url)) return Promise.resolve(env({ runId: 'run-organize', status: 'running', reused: false }));
    if (url.includes('/agent-runs/run-organize')) {
      return Promise.resolve(env({
        id: 'run-organize', kind: 'transcribe', sourceEntryId: AUDIO_ID, storeId: STORE_ID, userId: 'u-demo',
        status: 'running', phase: '正在按会议纪要重新整理', progress: 40,
        createdAt: new Date().toISOString(),
      }));
    }
    if (url.includes('/document-store/transcribe-styles')) return Promise.resolve(env(STYLES));
    if (url.includes('/entries/' + AUDIO_ID + '/content')) return Promise.resolve(env({ fileUrl: audioUrl, contentType: 'audio/mp4' }));
    if (url.includes('/entries/' + NOTE_ID + '/content'))  return Promise.resolve(env({ content: NOTE_MD, contentType: 'text/markdown' }));
    if (url.includes('/entries/' + AUDIO_ID))              return Promise.resolve(env(audioEntry));
    if (url.includes('/entries/' + NOTE_ID))               return Promise.resolve(env(noteEntry));
    if (url.includes('/stores/' + STORE_ID + '/entries'))  return Promise.resolve(env({ items: [audioEntry, noteEntry], total: 2 }));
    if (url.includes('/stores/' + STORE_ID))               return Promise.resolve(env({ id: STORE_ID, name: '产品研究', description: '' }));
    if (url.includes('/authz/me'))                         return Promise.resolve(env({ effectivePermissions: ['access', 'document-store.read', 'document-store.write'] }));
    // 兜底成功空信封：回 401 会把页面踢去 /login，截到的就不是要判的那一屏了。
    // 各处消费方对空集合的字段名不一样（items / fragments / entries…），
    // 少给一个就会在 useMemo 里抛「not iterable」把整棵树打崩——一次给全。
    return Promise.resolve(env({
      items: [], total: 0, fragments: [], entries: [], list: [], records: [], data: [],
      backlinks: [], forwardLinks: [], backlinksCount: 0, forwardLinksCount: 0,
    }));
  };
})();
`;
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const manifest = [];
const problems = [];

/** 滚动容器是页面里那个 overflow-auto 的 main，不是 window——`window.scrollTo` 在这一屏是空操作 */
const scrollTop = page => page.evaluate(() => {
  document.querySelectorAll('*').forEach((el) => { if (el.scrollTop > 0) el.scrollTop = 0; });
});

/**
 * 真人操作驱动。稿面 B2/B3/B4 画的都是**做过一个动作之后**的样子：搜过词、
 * 点过一张整理卡、问过一个问题。不驱到那一步就截图，判分看到的是空搜索框、
 * 四张「点击生成」、一张空输入卡——那不是实现缺失，是取证没走到。
 */
const DRIVERS = {
  async full(page, shot, theme, snap) {
    // B2：搜一个词，看命中计数与黄底高亮
    const search = page.getByPlaceholder('搜索原文关键词');
    if (await search.count()) {
      await search.first().fill('导入');
      await page.waitForTimeout(600);
      await snap('搜索命中');
      await search.first().fill('');
      await page.waitForTimeout(300);
    }

    // B4：问一个问题，等答案真的流完再截（没流完就截 = 断头验收）
    const ask = page.getByLabel('问这场录音');
    if (await ask.count()) {
      await ask.first().fill('为什么放弃导入？');
      await page.getByLabel('发送问题').first().click();
      await page.getByText('引用原文').first().waitFor({ timeout: 30_000 }).catch(() => undefined);
      await page.waitForTimeout(600);
      await page.getByRole('heading', { name: '问这场录音' }).first()
        .evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.waitForTimeout(300);
      await snap('问答已作答');

      // 点一下引用卡：稿面要求顶部播放条跟着跳到被引的那一句
      const citation = page.getByTitle('从引用位置播放');
      if (await citation.count()) {
        await citation.first().click();
        await page.waitForTimeout(700);
        await snap('引用跳播');
      } else {
        problems.push(`[${theme}] 引用跳播一屏没取到：找不到引用卡`);
      }

      /*
       * 再问一个原文里没有的问题：稿面 B4 顶部那条琥珀提示记的是
       * 「上一问没答上来、而且是如实说的」。不驱到这一步，就只能声称它做了——
       * 那是拿不会红的证据当证据。
       */
      await ask.first().fill('他们怎么看价格？');
      await page.getByLabel('发送问题').first().click();
      await page.getByText('无法从录音确认').first().waitFor({ timeout: 30_000 }).catch(() => undefined);
      await ask.first().fill('还有哪些人提到过重开');
      await page.getByLabel('发送问题').first().click();
      await page.getByText('上一问').first().waitFor({ timeout: 30_000 }).catch(() => undefined);
      await page.waitForTimeout(600);
      await page.getByRole('heading', { name: '问这场录音' }).first()
        .evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.waitForTimeout(300);
      await snap('如实说没有');
    }

    // B3：点「会议纪要」那张卡 → 真实页面发起 run 并轮询 → 卡上出现「生成中 40%」
    const meetingCard = page.getByRole('button', { name: /会议纪要/ });
    if (await meetingCard.count()) {
      await meetingCard.first().click();
      await page.waitForTimeout(2600); // 轮询 2s 一次，等它至少跑完一轮
      await page.getByRole('heading', { name: '一键整理' }).first()
        .evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.waitForTimeout(300);
      await snap('整理进行中');
    }

    /*
     * B2 还画了「点开某一句改原文」那一刻。同样是状态，不点开截不到：
     * 点第 4 行（绝对选择器，不用 nth——编辑中的那一行不是按钮，
     * nth 会在两轮主题之间整体位移）。
     */
    const row = page.locator('[data-transcript-row="3"]');
    if (await row.count()) {
      await row.first().click();
      await page.waitForTimeout(500);
      await snap('编辑原文');
      await page.keyboard.press('Escape').catch(() => undefined);
      const cancel = page.getByRole('button', { name: '取消' });
      if (await cancel.count()) await cancel.first().click().catch(() => undefined);
      await scrollTop(page);
      await page.waitForTimeout(300);
    }
  },

  /**
   * 最后驱一次「播放到一半」：稿面 B1/B2 的波形是左侧约四成染成强调色的，
   * 那是**播放进度**，00:00 时当然只有第一根。点波形四成处跳过去再起播。
   */
  async playing(page, shot, theme, snap) {
    await scrollTop(page);
    await page.waitForTimeout(500);
    const wave = page.locator('[title="点击跳到对应位置"]');
    const box = await wave.first().boundingBox().catch(() => null);
    if (!box) {
      // 取不到就明说取不到，不静默跳过——一条不会红的证据比没有证据更糟
      problems.push(`[${theme}] 播放中一屏没取到：波形不可见`);
      return;
    }
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height / 2);
    await page.waitForTimeout(400);
    await page.getByTitle('播放').first().click().catch(() => undefined);
    await page.waitForTimeout(900);
    await snap('播放中');
  },
};

for (const scene of ACTIVE) {
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({
      viewport: scene.viewport ?? { width: 390, height: 844 },
      deviceScaleFactor: 2,
      reducedMotion: 'reduce',
    });
    await ctx.addInitScript({ content: buildInit(scene) });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`[${scene.id}/${theme}] PAGEERROR ${e.message} @ ${(e.stack || '').split('\n')[1]?.trim() ?? ''}`));

    const url = `${BASE}${scene.url ?? `/document-store/${STORE_ID}/recording/${AUDIO_ID}`}`;
    const snap = async (section) => {
      const file = `${OUT}/${scene.id}.${theme}${section ? `.${section}` : ''}.png`;
      await page.screenshot({ path: file });
      manifest.push({ scene: scene.id, board: scene.board ?? null, theme, section: section ?? null, image: file, note: scene.note ?? '' });
      console.log(section ? `  ↳ ${section}` : `${scene.id} ${theme} -> ${url}`);
    };

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await page.waitForTimeout(scene.settleMs ?? 3500);
    const landed = new URL(page.url()).pathname;
    // 被守卫踢走了就直说，不要把登录页当成「那一屏」交上去
    if (landed.includes('/login')) problems.push(`[${scene.id}/${theme}] 被路由守卫踢到 ${landed}`);
    await snap('');

    for (const name of (scene.drive ?? [])) {
      const driver = DRIVERS[name];
      if (!driver) { problems.push(`[${scene.id}] 未知驱动 ${name}`); continue; }
      await driver(page, scene, theme, snap);
    }

    // 一屏装不下的部分按区块标题给下滚证据
    if (scene.sections !== false) {
      const headings = await page.locator('h3').all();
      for (const h of headings) {
        const name = (await h.innerText()).trim();
        if (!name) continue;
        await h.evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
        await page.waitForTimeout(250);
        await snap(name);
      }
    }

    // 场景声明了它必须出现的证据文案，就当场核一下——驱不到要明说，不能默认成立
    for (const must of (scene.expect ?? [])) {
      const hit = await page.getByText(must, { exact: false }).count().catch(() => 0);
      if (!hit) problems.push(`[${scene.id}/${theme}] 期望出现「${must}」但页面上没有`);
    }

    await ctx.close();
  }
}

fs.writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`\n场景 ${ACTIVE.length} 个 · 截图 ${manifest.length} 张 · 问题 ${problems.length}`);
if (problems.length) console.log(problems.map(p => '  ! ' + p).join('\n'));
await browser.close();
