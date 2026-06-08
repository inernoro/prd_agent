import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PWPATH || '/opt/node22/lib/node_modules/playwright');
const fs=require('fs');
const revealJs=fs.readFileSync('/tmp/reveal.js','utf8');const revealCss=fs.readFileSync('/tmp/reveal.css','utf8');
const b=await chromium.launch({headless:true,args:['--no-sandbox']});
for(const f of fs.readdirSync('/tmp/styles').filter(x=>x.endsWith('.html'))){
  let html=fs.readFileSync('/tmp/styles/'+f,'utf8'); if(html.length<200){console.log('skip',f,'(empty)');continue;}
  html=html.replace(/<link[^>]*reveal\.css[^>]*>/i,'<style>'+revealCss+'</style>').replace(/<script[^>]*reveal\.js[^>]*><\/script>/i,'<script>'+revealJs+'</script>');
  const p=await (await b.newContext({viewport:{width:1280,height:720}})).newPage();
  await p.setContent(html,{waitUntil:'load',timeout:20000});await p.waitForTimeout(2000);
  await p.screenshot({path:'/tmp/styles/'+f.replace('.html','.png')});
  console.log('rendered',f);
  await p.close();
}
await b.close();
