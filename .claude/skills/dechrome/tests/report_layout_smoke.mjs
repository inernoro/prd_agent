// Behavioral report check: use the same exported guard for an old report and its repair.
import {pathToFileURL} from 'node:url';

const assert=(condition,message)=>{if(!condition)throw Error(message)};
export async function verifyComparisonLayout(surface,keyboard){
 const pairs=surface.locator('[data-pair]');const count=await pairs.count();assert(count>0,'没有找到前后对照');
 const viewport=await surface.locator('body').evaluate(()=>innerWidth),records=[];
 for(let i=0;i<count;i++){
  const pair=pairs.nth(i),before=pair.locator('figure[data-phase="before"]'),after=pair.locator('figure[data-phase="after"]');
  assert(await before.isVisible()&&await after.isVisible(),`对照${i+1}默认未同时展示前后图，阅读仍需要切换`);
  const a=await before.locator('img').boundingBox(),b=await after.locator('img').boundingBox();
  const source=await before.locator('img').evaluate(e=>({width:e.naturalWidth,height:e.naturalHeight,loaded:e.complete&&e.naturalWidth>0}));
  assert(source.loaded&&a?.width>0&&b?.width>0,'证据图未加载');
  assert(Math.abs(a.width-b.width)<1,'前后图没有保持相同显示尺度');
  if(viewport>760&&source.width<source.height){assert(Math.abs(a.y-b.y)<1&&b.x>=a.x+a.width,'桌面竖图没有对齐并排');assert(a.width>=source.width*.85,'桌面竖图被无必要地缩成难读的小图')}
  else assert(b.y>=a.y+a.height,'宽图/窄屏前后图应自然上下排列，不能重叠');
  records.push({pair:i,displayWidth:a.width,sourceWidth:source.width,bothDisplayedByDefault:true});
 }
 const doc=await surface.locator('body').evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert(doc.scroll<=doc.width+1,'报告正文横向溢出');
 // Both portrait and wide evidence use one activation to open their own native-size original.
 const sample=[0,...(count>3?[3]:[])],originals=[];
 for(const i of sample){
  const trigger=pairs.nth(i).locator('figure[data-phase="after"] button');await trigger.click({trial:true});await trigger.focus();
  if(i===0)await trigger.click();else await trigger.press('Enter');
  const dialog=surface.getByRole('dialog');await dialog.waitFor({state:'visible'});const img=dialog.locator('img');
  await img.evaluate(e=>e.decode());const dimensions=await img.evaluate(e=>({source:e.naturalWidth,shown:e.getBoundingClientRect().width}));
  assert(dimensions.source===dimensions.shown,'一次激活没有直接显示100%原图');
  await keyboard.press('Shift+Tab');assert(await dialog.evaluate(e=>e.contains(e.ownerDocument.activeElement)),'原图弹层键盘焦点逸出');
  await keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert(await trigger.evaluate(e=>e===e.ownerDocument.activeElement),'关闭原图后没有恢复触发图的焦点');
  originals.push({pair:i,activations:1,nativeWidth:dimensions.shown,escapeAndFocusRestored:true});
 }
 return {verdict:'PASS',viewport:doc,comparisons:records,originals};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const target=process.argv[2];if(!target)throw Error('Usage: node report_layout_smoke.mjs URL');
 const {chromium}=await import(process.env.DECHROME_PLAYWRIGHT_MODULE||'playwright');
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox']});
 try{for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:width===390?844:900},reducedMotion:'reduce'});await page.goto(target);
  await page.locator('body').evaluate(async()=>{for(const i of document.querySelectorAll('figure img'))i.loading='eager';await Promise.all([...document.querySelectorAll('figure img')].map(i=>i.decode()));await document.fonts.ready});
  console.log(JSON.stringify({width,...await verifyComparisonLayout(page,page.keyboard)}));await page.close();
 }}finally{await browser.close()}
}
