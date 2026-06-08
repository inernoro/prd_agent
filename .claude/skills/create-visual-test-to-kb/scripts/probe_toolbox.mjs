import { loadConfig, launch, login, gotoByClick } from './harness.mjs';
const cfg = loadConfig(new URL('../acceptance.config.json', import.meta.url).pathname);
const { browser, page } = await launch(cfg, {});
try {
  await login(page, 'https://cds-agent-integration-x6rck-claude-prd-agent.miduo.org', cfg);
  await gotoByClick(page, '百宝箱').catch(()=>{});
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => {
    // find leaf text "PPT", walk up to clickable card
    let target=null;
    for (const el of document.querySelectorAll('*')) {
      if (el.childElementCount===0 && el.textContent.trim()==='PPT'){ target=el; break; }
    }
    if(!target) return {found:false};
    let cur=target, path=[];
    for(let i=0;i<8 && cur;i++){
      const cls=(cur.className&&cur.className.toString()||'').slice(0,60);
      const click=!!cur.onclick || cur.getAttribute('role')==='button';
      path.push(`${cur.tagName}.${cls}${click?'[CLICK]':''}`);
      cur=cur.parentElement;
    }
    // also full title text of the card (4 levels up)
    let card=target; for(let i=0;i<4&&card.parentElement;i++)card=card.parentElement;
    return {found:true, path, cardText:(card.textContent||'').trim().slice(0,60)};
  });
  console.log(JSON.stringify(info,null,1));
} catch(e){ console.log('ERR', e?.message); } finally { await browser.close(); }
