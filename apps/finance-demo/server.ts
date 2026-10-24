/** Isolated local HTTP adapter for real CAL-37/38/39 reducers. NOT CAL-29 persistence. */
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createAcceptedOwnerHandoff,createOwnerHandoffCurrent} from '../../packages/contracts/src/owner-handoff-fixtures.ts';
import {buildCal36FromOwnerHandoff} from '../../packages/contracts/src/cal36-shared-handoff.ts';
import {signDemoAgreement} from '../../packages/contracts/src/cal36-easement.ts';
import {approveCal37,settleCal37,emptyCal37State,cal37Status} from '../../packages/contracts/src/cal37-approval.ts';
import {emptyLaterState,simulateCompletion,settleCompletionBalance,advanceMonthlyPeriod,laterPublicView} from '../../packages/contracts/src/cal38-39-settlement.ts';
import {monthlyFeeDueDate} from '../../packages/contracts/src/owner-handoff.ts';
const packet=createAcceptedOwnerHandoff(),current=createOwnerHandoffCurrent(packet);
const issued=buildCal36FromOwnerHandoff(packet,current,'EasyGrid');
let signed=issued.agreementPackage;
for(const a of signed.agreements)signed=signDemoAgreement(signed,a.parcelId,a.ownerAlias,'2026-10-24T10:00:00Z',signed.packageHash);
let first=emptyCal37State(),later=emptyLaterState(),month=0,serial=0;
const completionDate='2026-10-24';
const error=(message:string):never=>{throw Error(message)};
export function snapshot(){
 const approval=first.approval;
 return {simulated:true,persistent:false,source:'REAL CAL-37/38/39 reducers; local in-memory adapter',
  approved:!!approval,firstPaid:first.ledger.length===packet.parcels.length&&first.ledger.every(e=>e.status==='paid'),
  completed:!!later.completion,balancePaid:later.payments.filter(p=>p.kind==='completion_balance'&&p.status==='paid').length===packet.parcels.length,
  month,completionDate:later.completion?.completedOn??null,
  dueDate:month&&later.completion?monthlyFeeDueDate(completionDate,month):null,
  owners:packet.owners.map(o=>({ownerId:o.ownerId,alias:o.alias,recipientDisplay:o.banking.bankDisplay+' '+o.banking.accountDisplay})),
  contracts:packet.parcels.map(p=>({parcelId:p.parcelId,ownerId:p.ownerId,compensationCents:p.terms.compensationCents,monthlyRentCents:p.terms.monthlyRentCents})),
  first:cal37Status(first),later:laterPublicView(later),
  firstLedger:first.ledger.map(e=>({obligationId:e.obligationId,parcelId:e.parcelId,amountCents:e.amountCents,status:e.status,receiptId:e.receiptId??null,recipientDisplay:e.recipientDisplay,simulated:true}))
 };
}
export function applyAction(action:string){
 const requestKey='demo-action-'+(++serial);
 if(action==='reset'){first=emptyCal37State();later=emptyLaterState();month=0;return snapshot()}
 if(action==='approve'){
  first=approveCal37({packet,current,issued,signed,operatorAlias:'EasyGrid',managerAlias:'Demo Manager',managerConfirmed:true,
   approvedAt:'2026-10-24T11:00:00Z',state:first,expectedStateRevision:first.revision});
 }else if(action==='first'||action==='first_fail'){
  first=settleCal37({packet,current,signed,state:first,expectedStateRevision:first.revision,
   attemptedAt:'2026-10-24T11:01:00Z',requestKey,outcome:action==='first'?'simulated_success':'simulated_failure'}).state;
 }else if(action==='complete'){
  later=simulateCompletion({packet,current,signed,first,later,expectedRevision:later.revision,completedOn:completionDate,operatorConfirmed:true});
 }else if(action==='balance'||action==='balance_fail'){
  later=settleCompletionBalance({packet,current,signed,first,later,expectedRevision:later.revision,
   requestKey,outcome:action==='balance'?'simulated_success':'simulated_failure'});
 }else if(action==='advance'){
  if(!later.completion)error('Completion required before monthly rent');
  if(month>=2)error('Only two demo periods supported');
  if(month===1&&later.payments.filter(p=>p.kind==='monthly_fee'&&p.period===monthlyFeeDueDate(completionDate,1).slice(0,7)).length!==packet.parcels.length)
   error('Record first month before advancing');
  month++;
 }else if(action==='rent'||action==='mismatch'||action==='rent_fail'){
  if(!month)error('Advance the demo clock first');
  const discrepancy=action==='mismatch'?{parcelId:packet.parcels[0]!.parcelId,actualCents:25000}:undefined;
  later=advanceMonthlyPeriod({packet,current,signed,first,later,expectedRevision:later.revision,
   month:month as 1|2,asOfDate:monthlyFeeDueDate(completionDate,month),requestKey,
   outcome:action==='rent_fail'?'simulated_failure':'simulated_success',...(discrepancy?{discrepancy}:{})});
 }else error('Unknown action');
 return snapshot();
}
const htmlPath=fileURLToPath(new URL('./connected.html',import.meta.url));
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 const host='127.0.0.1',port=Number(process.env.PORT||4173);
 createServer(async(req,res)=>{
  const respond=(status:number,body:string,contentType='application/json')=>{
   res.writeHead(status,{'content-type':contentType+'; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(body)};
  try{
   if(req.method==='GET'&&req.url==='/')return respond(200,await readFile(htmlPath,'utf8'),'text/html');
   if(req.method==='GET'&&req.url==='/api/state')return respond(200,JSON.stringify(snapshot()));
   if(req.method==='POST'&&req.url==='/api/action'){
    let body='';for await(const part of req){body+=part;if(body.length>1024)throw Error('Payload too large')}
    const parsed=JSON.parse(body);
    if(typeof parsed.action!=='string')throw Error('Missing action');
    return respond(200,JSON.stringify(applyAction(parsed.action)));
   }
   respond(404,JSON.stringify({error:'Not found'}));
  }catch(e){respond(400,JSON.stringify({error:e instanceof Error?e.message:'Unknown error'}))}
 }).listen(port,host,()=>console.log('Real reducer finance UI: http://'+host+':'+port));
}
