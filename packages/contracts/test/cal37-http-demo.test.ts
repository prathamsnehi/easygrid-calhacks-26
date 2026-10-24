import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../scripts/cal37-demo-server.ts',import.meta.url));
async function start(file:string){
 const child=spawn(process.execPath,['--experimental-strip-types',script],{
  env:{...process.env,PORT:'0',CAL37_STATE_FILE:file},stdio:['ignore','pipe','pipe']
 });
 const url=await new Promise<string>((resolve,reject)=>{
  let out='',err='';
  const timer=setTimeout(()=>reject(new Error('Demo server start timed out: '+err)),12000);
  child.stdout.on('data',(chunk:Buffer)=>{out+=String(chunk);const match=out.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});
  child.stderr.on('data',(chunk:Buffer)=>{err+=String(chunk);});
  child.on('error',e=>{clearTimeout(timer);reject(e);});
  child.on('exit',code=>{clearTimeout(timer);reject(new Error('Demo server exited '+code+': '+err));});
 });
 return {child,url};
}
test('CAL-37 real HTTP fallback: explicit approval, mock receipts, refresh, stale and restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'easygrid-cal37-')),file=join(dir,'state.json');
 let child:ReturnType<typeof spawn>|undefined;
 try{
  const first=await start(file);child=first.child;
  const get=async(url:string)=>{const r=await fetch(url+'/api/status');assert.equal(r.status,200);return r.json();};
  const post=async(url:string,path:string,body:Record<string,unknown>)=>{
   const r=await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
   return {status:r.status,data:await r.json()};
  };
  const initial=await get(first.url);
  assert.equal(initial.approval,'not_approved');assert.equal(initial.revision,0);
  const bad=await post(first.url,'/api/pay',{sessionId:initial.sessionId,expectedRevision:0,confirmSimulated:true,requestKey:'early'});
  assert.equal(bad.status,400);
  const denied=await post(first.url,'/api/approve',{sessionId:initial.sessionId,expectedRevision:0,managerConfirmed:false,managerAlias:'Demo'});
  assert.equal(denied.status,400);
  const approved=await post(first.url,'/api/approve',{sessionId:initial.sessionId,expectedRevision:0,managerConfirmed:true,managerAlias:'Demo'});
  assert.equal(approved.status,200);assert.equal(approved.data.approval,'approved');
  const stale=await post(first.url,'/api/pay',{sessionId:initial.sessionId,expectedRevision:0,confirmSimulated:true,requestKey:'stale'});
  assert.equal(stale.status,409);
  const attempted=await post(first.url,'/api/pay',{sessionId:initial.sessionId,expectedRevision:1,confirmSimulated:true,outcome:'simulated_failure',requestKey:'failed'});
  assert.equal(attempted.status,200);assert.equal(attempted.data.attempted,2);assert.equal(attempted.data.paid,0);
  const paid=await post(first.url,'/api/pay',{sessionId:initial.sessionId,expectedRevision:2,confirmSimulated:true,outcome:'simulated_success',requestKey:'retry'});
  assert.equal(paid.status,200);assert.equal(paid.data.paid,2);
  assert.deepEqual(paid.data.receipts.map((x:{amountCents:number})=>x.amountCents),[240000,160000]);
  assert.ok(paid.data.receipts.every((x:{label:string})=>x.label.includes('NO REAL FUNDS')));
  const refreshed=await get(first.url);
  assert.equal(refreshed.revision,3);assert.equal(refreshed.paid,2);
  assert.equal(JSON.stringify(refreshed).includes('paymentRecipientRef'),false);
  assert.ok(refreshed.payments.every((x:{recipientDisplay:string})=>/\*{4}\d{4}/.test(x.recipientDisplay)));
  const duplicate=await post(first.url,'/api/pay',{sessionId:initial.sessionId,expectedRevision:3,confirmSimulated:true,outcome:'simulated_success',requestKey:'new-key'});
  assert.equal(duplicate.status,400);
  first.child.kill();await new Promise<void>(resolve=>first.child.once('exit',()=>resolve()));child=undefined;
  const restarted=await start(file);child=restarted.child;
  const restored=await get(restarted.url);
  assert.equal(restored.revision,3);assert.equal(restored.paid,2);
 }finally{child?.kill();rmSync(dir,{recursive:true,force:true});}
});
