import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createContractAPI } from './server/contract-api.mjs';
import { createConfiguredVoiceService } from './server/voice-service.mjs';
import { acquireLedgerProcessLock } from './server/ledger-process-lock.mjs';
const ledgerLock=process.env.EASYGRID_PAYMENT_PROVIDER==='nessie'
  ? acquireLedgerProcessLock(new URL('./.local/nessie-server.lock',import.meta.url)) : null;
if(ledgerLock){
  // Exit ends every in-flight request before the exit hook releases ownership.
  process.once('SIGINT',()=>process.exit(130));
  process.once('SIGTERM',()=>process.exit(143));
}
let contractAPI;
const voice=await createConfiguredVoiceService();
try {
  contractAPI=await createContractAPI(voice.coordinator ? {
    resolveProposal:context=>voice.coordinator.resolveProposal(context),
    resolveNegotiation:input=>voice.coordinator.resolveNegotiation(input),
  } : {});
  voice.coordinator?.setApproveMap((context,options)=>contractAPI.approveMap(context,options));
}
catch (error) { ledgerLock?.release(); throw error; }
const previewPort=Number(process.env.EASYGRID_PREVIEW_PORT??4177);
const resources=new Map([
  ['/', ['index.html','text/html; charset=utf-8']],
  ['/index.html', ['index.html','text/html; charset=utf-8']],
  ['/contracts.html', ['contracts.html','text/html; charset=utf-8']],
  ['/parcel-fixtures.json', ['parcel-fixtures.json','application/json; charset=utf-8']],
  ['/demo-handoff-example.json', ['demo-handoff-example.json','application/json; charset=utf-8']],
]);
const server=createServer(async (req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(await voice.api(req,res,path))return;
  if(await contractAPI(req,res,path))return;
  if(path==='/favicon.ico'){res.writeHead(204).end();return;}
  const resource=resources.get(path);
  if(!resource){res.writeHead(404).end('Not found.');return;}
  try{
    const bytes=await readFile(new URL(`./dist/${resource[0]}`,import.meta.url));
    res.writeHead(200,{'content-type':resource[1],'cache-control':'no-store'});res.end(bytes);
  }catch{res.writeHead(500).end('Build the preview first.');}
});
server.once('close',()=>voice.api.close());
server.once('error',error=>{
  // An uncaught listen error exits, which releases the lock synchronously.
  throw error;
});
server.listen(previewPort,'127.0.0.1',()=>console.log(`Local: http://127.0.0.1:${previewPort}`));
