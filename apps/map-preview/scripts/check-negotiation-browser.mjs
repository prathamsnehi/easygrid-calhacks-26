// Real browser rendering check with a synthetic subscription, not a live or persisted demo.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE??'playwright');
const browser=await chromium.launch({headless:true,
  ...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),
  args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(new URL('../dist/index.html',import.meta.url).href);
  await page.waitForFunction(()=>document.documentElement.dataset.mapReady==='true');
  await page.fill('#user-alias','Synthetic Browser Participant');
  await page.fill('#user-phone','2025550123');await page.check('#user-consent');await page.click('#save-user');
  for(let i=0;i<2;i++){await page.click('#next-site');await page.click('#confirm-placement');}
  await page.waitForFunction(()=>window.easygridDemo.getHandoff()!==null,{},{timeout:30000});
  await page.click('#open-analysis');
  const result=await page.evaluate(()=>{
    const api=window.easygridDemo;let callback;
    api.setNegotiationResultSource(({onUpdate,onReady})=>{callback=onUpdate;onReady();});
    const h=api.getHandoff(),binding=api.getNegotiationBinding();
    const base={schemaVersion:1,kind:'easygrid-negotiation-result',eventId:'browser-review',revision:10,saved:true,
      mapBinding:binding,localParcelId:h.userRole.parcelId,mode:'simulated',phase:'confirming',summary:null};
    callback(base);
    const confirming=document.querySelector('#handoff-status-badge').textContent;
    callback({...base,eventId:'browser-final',revision:11,phase:'finished',summary:{attemptId:'synthetic-browser-attempt',mode:'simulated',
      disposition:'unsuccessful',reason:'PRICE_REJECTED',outcome:'refused',nextAction:'stop',
      explanation:'Owner requested $15,000; our final offer was $12,000. Price too high.'}});
    return {confirming,routeId:h.ownerHandoff.routeId};
  });
  assert(result.confirming.includes('CONFIRMING RESULT'));
  assert.equal(await page.locator('#handoff-status-badge').textContent(),'UNSUCCESSFUL · SIMULATED');
  assert.equal(await page.locator('#handoff-result').textContent(),'Owner requested $15,000; our final offer was $12,000. Price too high.');
  assert(await page.locator('#agent-call').isDisabled());assert(await page.locator('#handoff-result').isVisible());
  assert.equal(await page.evaluate(()=>window.easygridDemo.getHandoff().ownerHandoff.routeId),result.routeId);
  assert.deepEqual(errors,[]);
  await page.locator('#handoff-result').scrollIntoViewIfNeeded();
  const box=await page.locator('#handoff-result').boundingBox();assert(box&&box.y>=0&&box.y+box.height<=1000);
  const screenshot=process.env.BROWSER_SCREENSHOT??'/private/tmp/cal34-browser-result.png';
  await page.screenshot({path:screenshot,fullPage:true});
  console.log(JSON.stringify({passed:true,scope:'Synthetic result subscription + actual Chrome/WebGL rendering; no provider calls or database writes',screenshot}));
}finally{await browser.close();}
