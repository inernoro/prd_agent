import { loadConfig, launch, login } from './harness.mjs';
const cfg = loadConfig(new URL('../acceptance.config.json', import.meta.url).pathname);
const BASE = process.argv[2];
const { browser, page } = await launch(cfg);
try {
  await login(page, BASE, cfg);
  await page.goto(BASE.replace(/\/+$/,'') + '/md-to-ppt-agent', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('textarea', { timeout: 20000 });
  const out = await page.evaluate(async () => {
    let token=''; const v=sessionStorage.getItem('prd-admin-auth')||localStorage.getItem('prd-admin-auth')||''; try{const j=JSON.parse(v); token=j.token||j.state?.token||'';}catch{}
    const H={'Content-Type':'application/json',Authorization:`Bearer ${token}`};
    const call=async(slides,label)=>{try{const r=await fetch('/api/md-to-ppt/render',{method:'POST',headers:H,body:JSON.stringify({slides,theme:'black'})});return{label,status:r.status,ct:r.headers.get('content-type'),server:r.headers.get('server'),body:(await r.text()).slice(0,120)};}catch(e){return{label,err:String(e)};}};
    const real=[{title:'A与B的深入探讨',bullets:['基于用户输入内容的内容分析']},{title:'A主题介绍',bullets:['x是A的核心要素','A的应用领域广泛','A的主要优势明显','A的发展前景广阔']},{title:'B主题介绍',bullets:['y是B的关键特征','B的适用场景多样','B的技术难点可控','B的优化空间较大']},{title:'A的具体应用',bullets:['案例一：提升效率','案例二：降低成本','案例三：改善体验','案例四：增强安全性']},{title:'B的具体应用',bullets:['案例一：数据整合','案例二：流程自动化','案例三：决策支持','案例四：客户洞察']},{title:'A与B的对比分析',bullets:['两者共同点：优化流程','A更注重效率','B更注重灵活性','互补使用效果更佳']},{title:'综合应用方案',bullets:['结合A和B的框架','步骤一：需求梳理','步骤二：模块部署','步骤三：效果评估']},{title:'总结',bullets:['A与B各有优势','结合使用价值最大','未来前景广阔']}];
    const benign=Array.from({length:8},(_,i)=>({title:`Slide ${i+1}`,bullets:['point one','point two','point three','point four']}));
    return { real: await call(real,'real-8'), benign: await call(benign,'benign-8') };
  });
  console.log('BISECT', JSON.stringify(out, null, 1));
} catch (e) { console.error('ERR', e.message); }
finally { await browser.close(); }
