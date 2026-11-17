/** 独立页面：仅合成匿名会话/公开结果；不输入凭据、提交登录或公开真实服务。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const gate = () => { let release; const promise = new Promise(r => release = r); return { promise, release }; };

/** 从首个 DOM 变更开始观察，防止首页开场动画前短暂闪过通用骨架。 */
async function verifyHomeOpening(browser, base, out) {
  const results = [];
  for (const scenario of [
    { name: 'normal', width: 1440, colorScheme: 'dark', reducedMotion: 'no-preference', slow: false },
    { name: 'slow', width: 1440, colorScheme: 'dark', reducedMotion: 'no-preference', slow: true },
    { name: 'mobile-light', width: 390, colorScheme: 'light', reducedMotion: 'no-preference', slow: false },
    { name: 'reduced-motion', width: 390, colorScheme: 'light', reducedMotion: 'reduce', slow: false },
  ]) {
    const context = await browser.newContext({ viewport: { width: scenario.width, height: 940 }, colorScheme: scenario.colorScheme, reducedMotion: scenario.reducedMotion });
    const session = gate();
    try {
      // 首页进入不依赖会话探测返回；慢资源仅在测试网络层延迟。
      await context.route('**/api/**', async route => { await session.promise; await route.fulfill({ json: { enabled: true, authenticated: false } }); });
      if (scenario.slow) await context.route('**/assets/**', async route => { await new Promise(resolve => setTimeout(resolve, 300)); await route.continue(); });
      await context.addInitScript(() => {
        window.__homeOpening = { sawSkeleton: false, bootMounts: 0 };
        new MutationObserver(records => {
          for (const record of records) for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (node.matches('[data-content-loading], .cds-loading-skeleton-panel, .cds-loading-skeleton-line') || node.querySelector('[data-content-loading], .cds-loading-skeleton-panel, .cds-loading-skeleton-line')) window.__homeOpening.sawSkeleton = true;
            window.__homeOpening.bootMounts += Number(node.matches('.cdsh-boot')) + node.querySelectorAll('.cdsh-boot').length;
          }
        }).observe(document, { childList: true, subtree: true });
      });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const requested = [];
      page.on('request', request => requested.push(request.url()));
      await page.goto(base + '/');
      await page.getByRole('heading', { name: '分支，即环境。', exact: true }).waitFor({ state: 'attached' });
      await page.locator('.cdsh-boot').waitFor({ state: 'attached' });
      if (scenario.reducedMotion === 'reduce') {
        assert.equal(await page.locator('.cdsh-boot').evaluate(e => getComputedStyle(e).display), 'none');
      } else {
        await page.waitForFunction(() => document.querySelector('.cdsh-boot-top').getAnimations().every(a => a.playState === 'finished'));
        assert(await page.locator('.cdsh-boot-top').evaluate(e => e.getBoundingClientRect().bottom <= 0), 'opening curtain must leave the screen');
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'homepage must fit the viewport');
      const opening = await page.evaluate(() => window.__homeOpening);
      assert.equal(opening.sawSkeleton, false, 'homepage must never render a generic skeleton before its opening animation');
      assert.equal(opening.bootMounts, 1, 'homepage must play one opening, without remounting the curtain');
      assert(!requested.some(url => /\/assets\/BranchlineScene-/.test(url)), '3D narrative must remain deferred until scroll');
      assert.deepEqual(errors, []);
      await page.screenshot({ path: path.join(out, `home-${scenario.name}.jpg`) });
      results.push({ kind: 'home', scenario: scenario.name, ...opening, deferred3D: true, errors });
      console.log(`PASS standalone home ${scenario.name}`);
    } finally { session.release(); await context.close(); }
  }
  return results;
}

export async function verifyPublicLoading(browser, base, out) {
  const results = await verifyHomeOpening(browser, base, out);
  for (const kind of ['login', 'public-status']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 940 }, colorScheme: 'dark' });
    const chunk = gate(), session = gate(), config = gate(), board = gate(), configSeen = gate(), boardSeen = gate();
    const errors = []; let failBoard = false, failNext = true; const nextBoard = gate(), nextSeen = gate();
    const selector = kind === 'login' ? '[data-auth-form-skeleton]' : '[data-public-status-skeleton]';
    await context.route(`**/assets/${kind === 'login' ? 'LoginPage' : 'PublicStatusPage'}-*.js`, async route => { await chunk.promise; await route.continue(); });
    await context.route('**/api/**', async route => {
      const p = new URL(route.request().url()).pathname;
      if (p === '/api/auth/status') return route.fulfill({json:{enabled:true,authenticated:false}});
      if (p === '/api/me') {await session.promise; return route.fulfill({status:401,json:{error:'synthetic anonymous'}});}
      if (p === '/api/auth/public-status' || p === '/api/auth/bootstrap-status') {
        configSeen.release(); await config.promise;
        return route.fulfill({json:p.endsWith('/bootstrap-status') ? {needsBootstrap:false} : {enabled:true,mode:'basic',loginMethods:{local:true,github:false,sso:false},capabilities:{userManagement:false,userActivity:false,durableUsers:true}}});
      }
      if (p.endsWith('/fixture-next-token')) {
        nextSeen.release(); await nextBoard.promise;
        return route.fulfill(failNext ? {status:500,json:{error:'synthetic new token failure'}} : {json:{title:'合成第二状态',headline:'第二状态正常',status:'ok',items:[],updatedAt:Date.now(),refreshHintSeconds:60}});
      }
      if (p.startsWith('/api/public/status/')) {
        boardSeen.release(); await board.promise;
        return route.fulfill({status:failBoard?500:200,json:failBoard?{error:'synthetic'}:{title:'合成公开状态',headline:'合成服务正常',status:'ok',items:[],updatedAt:Date.now(),refreshHintSeconds:60}});
      }
      return route.fulfill({json:{}});
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    async function measure(phase) {
      const box = await page.locator(selector).evaluate(e => {
        const r=e.getBoundingClientRect();
        return {x:r.x,y:r.y,width:r.width,height:r.height,lines:[...e.querySelectorAll('.cds-loading-skeleton-line')].map(l=>{const b=l.getBoundingClientRect();return [b.x-r.x,b.y-r.y,b.width,b.height]})};
      });
      await page.screenshot({path:path.join(out,`${kind}-${phase}.jpg`)}); return box;
    }
    try {
      await page.goto(base + (kind === 'login' ? '/login' : '/s/fixture-public-token'));
      await page.locator(selector).waitFor();
      const code = await measure('code'); chunk.release();
      if (kind === 'login') {
        await page.waitForFunction(()=>performance.getEntriesByType('resource').some(e=>/LoginPage-.*\.js/.test(e.name)));
        await page.locator(selector).waitFor();
        const pending = await measure('session');
        for(const key of ['x','y','width','height']) assert(Math.abs(code[key]-pending[key])<1,`${kind} session ${key} moved`);
        session.release(); await configSeen.promise;
        await page.getByRole('status',{name:'正在检查会话',exact:true}).waitFor();
        // session → 登录方式/首次初始化探测仍保留整副骨架。
        const methods = await measure('methods');
        for(const key of ['x','y','width','height']) assert(Math.abs(code[key]-methods[key])<1,`${kind} methods ${key} moved`);
        config.release(); await page.getByRole('button',{name:'登录',exact:true}).waitFor();
        assert.equal(await page.locator(selector).count(),0);
        assert.equal(await page.getByLabel('用户名',{exact:true}).count(),1);
        const ready=await page.locator('form.cds-auth-card').boundingBox();
        assert(Math.abs(ready.height-code.height)<1 && Math.abs(ready.y-code.y)<1, 'basic login readiness must preserve card geometry');
      } else {
        session.release(); config.release();
        await page.waitForFunction(()=>performance.getEntriesByType('resource').some(e=>/PublicStatusPage-.*\.js/.test(e.name)));
        await boardSeen.promise;
        const pending=await measure('data');
        for(const key of ['x','y','width','height']) assert(Math.abs(code[key]-pending[key])<1,`${kind} ${key} moved`);
        await page.setViewportSize({width:390,height:844}); await page.emulateMedia({reducedMotion:'reduce'});
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        assert.equal(await page.locator('.cds-loading-skeleton-line').first().evaluate(e=>getComputedStyle(e).animationName),'none');
        failBoard=true; board.release(); await page.getByRole('alert').filter({hasText:'暂时无法读取状态'}).waitFor();
        assert.equal(await page.locator(selector).count(),0);
        failBoard=false; await page.getByRole('button',{name:'重新读取',exact:true}).click(); await page.getByRole('heading',{name:'合成公开状态 服务状态',exact:true}).waitFor();
        assert.equal(await page.locator('[aria-label="主导航"]').count(),0);
        await page.evaluate(()=>{history.pushState({},'', '/s/fixture-next-token');window.dispatchEvent(new PopStateEvent('popstate'));});
        await nextSeen.promise; await page.locator(selector).waitFor();
        assert.equal(await page.getByRole('heading',{name:'合成公开状态 服务状态',exact:true}).count(),0);
        nextBoard.release(); await page.getByRole('alert').filter({hasText:'暂时无法读取状态'}).waitFor();
        assert.equal(await page.getByRole('heading',{name:'合成公开状态 服务状态',exact:true}).count(),0);
        failNext=false;await page.getByRole('button',{name:'重新读取',exact:true}).click();
        await page.getByRole('heading',{name:'合成第二状态 服务状态',exact:true}).waitFor();

      }
      assert.deepEqual(errors,[]); results.push({kind,codeDataGeometry:true,thirdLoginWait:kind==='login',publicFailureRetry:kind==='public-status',publicTokenIsolation:kind==='public-status',errors});
      console.log(`PASS standalone ${kind}`);
    } catch(error) {
      await page.screenshot({path:path.join(out,`${kind}-failure.jpg`)});
      await fs.writeFile(path.join(out,`${kind}-failure.html`),await page.content());
      throw new Error(`standalone ${kind}: ${error}`);
    } finally {chunk.release();session.release();config.release();board.release();nextBoard.release();await context.close();}
  }
  await fs.writeFile(path.join(out,'public-results.json'),JSON.stringify(results,null,2)); return results;
}
