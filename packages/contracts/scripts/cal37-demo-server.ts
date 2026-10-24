/** CAL-37 LOCAL FALLBACK ONLY. No SpacetimeDB, no real funds, no provider calls. */
import {createServer} from 'node:http';
import {readFileSync,writeFileSync,renameSync,existsSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAcceptedOwnerHandoff,createOwnerHandoffCurrent} from '../src/owner-handoff-fixtures.ts';
import {buildCal36FromOwnerHandoff} from '../src/cal36-shared-handoff.ts';
import {signDemoAgreement} from '../src/cal36-easement.ts';
import {emptyCal37State,approveCal37Authoritatively,settleCal37Authoritatively,cal37PublicView,type Cal37State} from '../src/cal37-approval.ts';
const here=dirname(fileURLToPath(import.meta.url));
const packet=createAcceptedOwnerHandoff(),current=createOwnerHandoffCurrent(packet);
const issued=buildCal36FromOwnerHandoff(packet,current,'EasyGrid');
let signed=issued.agreementPackage;
for(const a of signed.agreements)signed=signDemoAgreement(signed,a.parcelId,a.ownerAlias,'2026-10-24T10:00:00Z',signed.packageHash);
const file=resolve(process.env.CAL37_STATE_FILE??resolve(here,'../.cal37-demo-state.json'));
let state:Cal37State=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):emptyCal37State();
function persist(next:Cal37State){
 mkdirSync(dirname(file),{recursive:true});
 const tmp=file+'.tmp';writeFileSync(tmp,JSON.stringify(next,null,2),{mode:0o600});renameSync(tmp,file);
}
const store={
 async load(sessionId:string){if(sessionId!==packet.sessionId)throw Error('Unknown session');return {packet,current,issued,signed,state:structuredClone(state)};},
 async compareAndSwap(sessionId:string,expected:number,next:Cal37State){
  if(sessionId!==packet.sessionId||state.revision!==expected)return false;
  persist(next);state=structuredClone(next);return true;
 }
};
const ui=readFileSync(resolve(here,'cal37-demo.html'),'utf8');
const port=Number(process.env.PORT??4177);
const server=createServer(async(req,res)=>{
 const send=(code:number,body:unknown)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
 if(req.url==='/'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(ui);return;}
 if(req.url==='/api/status'&&req.method==='GET'){send(200,{sessionId:packet.sessionId,routeId:packet.routeId,routeVersion:packet.routeVersion,
  owners:packet.parcels.map(p=>({parcelId:p.parcelId,ownerId:p.ownerId,alias:packet.owners.find(o=>o.ownerId===p.ownerId)?.alias,
   compensationCents:p.terms.compensationCents,contract20Cents:Math.floor(p.terms.compensationCents/5)})),
  ...cal37PublicView(state)});return;}
 if(req.url!=='/api/approve'&&req.url!=='/api/pay'){send(404,{error:'Not found'});return;}
 if(req.method!=='POST'){send(405,{error:'POST required'});return;}
 let raw='';try{
  for await(const chunk of req){raw+=String(chunk);if(raw.length>4096)throw Error('Request too large');}
  const body=JSON.parse(raw);
  if(body.sessionId!==packet.sessionId)throw Error('Session mismatch');
  if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision!==state.revision){send(409,{error:'Stale session revision'});return;}
  if(req.url==='/api/approve'){
   if(body.managerConfirmed!==true||typeof body.managerAlias!=='string')throw Error('Explicit manager confirmation required');
   await approveCal37Authoritatively(store,packet.sessionId,{operatorAlias:'EasyGrid',managerAlias:body.managerAlias,
    managerConfirmed:true,approvedAt:new Date().toISOString()});
   send(200,{...cal37PublicView(state)});return;
  }
  if(body.confirmSimulated!==true||typeof body.requestKey!=='string')throw Error('Explicit simulated payment confirmation required');
  const result=await settleCal37Authoritatively(store,packet.sessionId,{attemptedAt:new Date().toISOString(),
   outcome:body.outcome==='simulated_failure'?'simulated_failure':'simulated_success',requestKey:body.requestKey});
  send(200,{...cal37PublicView(state),receipts:result.receipts});return;
 }catch(e){send(400,{error:e instanceof Error?e.message:'Invalid request'});}
});
server.listen(port,'127.0.0.1',()=>console.log('SIMULATED LOCAL CAL-37 fallback: http://127.0.0.1:'+port));
