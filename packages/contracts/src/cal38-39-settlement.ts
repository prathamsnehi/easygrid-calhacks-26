/** CAL-38/39 domain reducer. Simulation only; CAL-29 owns authoritative persistence. */
import { createHash } from 'node:crypto';
import { EasementError, type DemoAgreementPackage } from './cal36-easement.ts';
import { cal37ApprovedRecipientHandoff, type Cal37State } from './cal37-approval.ts';
import { monthlyFeeDueDate, settlementObligationId, splitCompensation, type OwnerHandoff, type CurrentHandoffState } from './owner-handoff.ts';

export type LaterPayment = {
 obligationId:string; parcelId:string; ownerId:string; recipientDisplay:string;
 amountCents:number; expectedCents:number; status:'attempted'|'paid'|'discrepant';
 kind:'completion_balance'|'monthly_fee'; period?:string; requestKey:string;
 simulated:true; label:'SIMULATED PAYMENT — NO REAL FUNDS TRANSFERRED';
};
export type CompletionEvent = {id:string;sessionId:string;routeId:string;approvalId:string;completedOn:string;simulated:true};
export type LaterState = {revision:number;completion:CompletionEvent|null;payments:LaterPayment[]};
export const emptyLaterState=():LaterState=>({revision:0,completion:null,payments:[]});
const error=(message:string):never=>{throw new EasementError('BLOCKED_STATE',message);};
const id=(...parts:unknown[])=>'sim-'+createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0,24);
const date=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
type Context={packet:OwnerHandoff;current:CurrentHandoffState;signed:DemoAgreementPackage;first:Cal37State;later:LaterState;expectedRevision:number};
function verify(c:Context){
 if(c.later.revision!==c.expectedRevision)error('Stale later-stage revision');
 if(new Set(c.later.payments.map(p=>p.obligationId)).size!==c.later.payments.length)error('Duplicate payment obligations');
 const approved=cal37ApprovedRecipientHandoff(c.packet,c.current,c.signed,c.first);
 for(const h of approved){
  const first=c.first.ledger.find(e=>e.parcelId===h.parcelId&&e.status==='paid'&&e.obligationId===h.contractTrancheObligationId);
  if(!first||first.amountCents!==splitCompensation(h.compensationCents).contractTrancheCents||
   first.paymentRecipientRef!==h.paymentRecipientRef)error('Every contract-stage 20% payment must settle first');
 }
 if(c.first.ledger.filter(e=>e.status==='paid').length!==approved.length)error('Incomplete initial settlement');
 if(c.later.completion&&(c.later.completion.sessionId!==c.packet.sessionId||
 c.later.completion.routeId!==c.packet.routeId||
 c.later.completion.approvalId!==c.first.approval!.approvalId))error('Stale completion event');
 return approved;
}
export function simulateCompletion(c:Context & {completedOn:string;operatorConfirmed:boolean}):LaterState{
 verify(c);
 if(c.later.completion)error('Completion already recorded');
 if(!c.operatorConfirmed||!date(c.completedOn))error('Explicit valid completion date required');
 return {...c.later,revision:c.later.revision+1,completion:{
 id:id(c.packet.sessionId,c.first.approval!.approvalId,'completion'),
 sessionId:c.packet.sessionId,routeId:c.packet.routeId,
 approvalId:c.first.approval!.approvalId,completedOn:c.completedOn,simulated:true}};
}
export function settleCompletionBalance(c:Context & {requestKey:string;outcome:'simulated_success'|'simulated_failure'}):LaterState{
 const approved=verify(c);
 if(!c.later.completion)error('Completion required');
 if(!c.requestKey.trim())error('Request key required');
 const payments=[...c.later.payments];
 for(const h of approved){
  const obligationId=h.completionBalanceObligationId;
  const previous=payments.find(p=>p.obligationId===obligationId);
  if(previous?.status==='paid')continue;
  const expectedCents=splitCompensation(h.compensationCents).completionBalanceCents;
  const row:LaterPayment={obligationId,parcelId:h.parcelId,ownerId:h.ownerId,
   recipientDisplay:h.recipientDisplay,amountCents:expectedCents,expectedCents,
   kind:'completion_balance',requestKey:c.requestKey,simulated:true,
   status:c.outcome==='simulated_success'?'paid':'attempted',
   label:'SIMULATED PAYMENT — NO REAL FUNDS TRANSFERRED'};
  if(previous)payments[payments.indexOf(previous)]=row;else payments.push(row);
 }
 if(payments.length===c.later.payments.length&&payments.every((p,i)=>p===c.later.payments[i]))error('Balance already settled');
 return {...c.later,revision:c.later.revision+1,payments};
}
/** First monthly anniversary after completion, then monthly. No proration. */
export function advanceMonthlyPeriod(c:Context & {
 month:1|2;asOfDate:string;requestKey:string;outcome:'simulated_success'|'simulated_failure';
 /** Optional deliberately discrepant amount; never treated as matched/paid. */
 discrepancy?:{parcelId:string;actualCents:number};
}):LaterState{
 const approved=verify(c);
 if(!c.later.completion)error('No rent before completion');
 const completion=c.later.completion!;
 if(!date(c.asOfDate)||!c.requestKey.trim())error('Invalid date or request key');
 const due=monthlyFeeDueDate(completion.completedOn,c.month);
 if(c.asOfDate<due)error('Monthly period not due');
 if(c.month===2&&!approved.every(h=>c.later.payments.some(p=>p.kind==='monthly_fee'&&
  p.parcelId===h.parcelId&&p.period===monthlyFeeDueDate(completion.completedOn,1).slice(0,7))))
  error('First month must be recorded before second month');
 const period=due.slice(0,7),payments=[...c.later.payments];
 if(c.discrepancy&&(!approved.some(h=>h.parcelId===c.discrepancy!.parcelId)||
 !Number.isSafeInteger(c.discrepancy.actualCents)||c.discrepancy.actualCents<0))
 error('Invalid discrepancy');
 for(const h of approved){
  const obligationId=settlementObligationId(c.packet.sessionId,h.parcelId,'monthly_fee',period);
  const previous=payments.find(p=>p.obligationId===obligationId);
  if(previous?.status==='paid'||previous?.status==='discrepant')continue;
  const expectedCents=h.monthlyRentCents;
  const amountCents=c.discrepancy?.parcelId===h.parcelId?c.discrepancy.actualCents:expectedCents;
  const status=amountCents!==expectedCents?'discrepant':c.outcome==='simulated_success'?'paid':'attempted';
  const row:LaterPayment={obligationId,parcelId:h.parcelId,ownerId:h.ownerId,
   recipientDisplay:h.recipientDisplay,amountCents,expectedCents,kind:'monthly_fee',
   period,requestKey:c.requestKey,status,simulated:true,
   label:'SIMULATED PAYMENT — NO REAL FUNDS TRANSFERRED'};
  if(previous)payments[payments.indexOf(previous)]=row;else payments.push(row);
 }
 if(payments.length===c.later.payments.length&&payments.every((p,i)=>p===c.later.payments[i]))error('Period already recorded');
 return {...c.later,revision:c.later.revision+1,payments};
}
export function laterPublicView(state:LaterState){
 const expected=state.payments.reduce((n,p)=>n+p.expectedCents,0);
 const paid=state.payments.filter(p=>p.status==='paid').reduce((n,p)=>n+p.amountCents,0);
 const unmatched=state.payments.filter(p=>p.status==='attempted').reduce((n,p)=>n+p.expectedCents,0);
 const discrepant=state.payments.filter(p=>p.status==='discrepant').reduce((n,p)=>n+Math.abs(p.expectedCents-p.amountCents),0);
 return {simulated:true,label:'SIMULATED PAYMENT — NO REAL FUNDS TRANSFERRED',
  completedOn:state.completion?.completedOn??null,expectedCents:expected,
  paidCents:paid,unmatchedCents:unmatched,discrepantCents:discrepant,
  payments:state.payments.map(({obligationId,parcelId,recipientDisplay,kind,period,status,amountCents,expectedCents,label})=>
   ({obligationId,parcelId,recipientDisplay,kind,period,status,amountCents,expectedCents,label}))};
}
/** CAL-29 must implement load + transactional CAS, including CAL-37 and later state in one authoritative session. */
export interface LaterAuthoritativeStore{
 load(sessionId:string):Promise<Omit<Context,'expectedRevision'>>;
 compareAndSwap(sessionId:string,expectedRevision:number,next:LaterState):Promise<boolean>;
}
export async function commitLaterAction(store:LaterAuthoritativeStore,sessionId:string,
 action:(context:Context)=>LaterState):Promise<LaterState>{
 const snapshot=await store.load(sessionId);
 if(snapshot.packet.sessionId!==sessionId||snapshot.current.sessionId!==sessionId)error('Session mismatch');
 const next=action({...snapshot,expectedRevision:snapshot.later.revision});
 if(!await store.compareAndSwap(sessionId,snapshot.later.revision,next))error('Concurrent settlement rejected');
 return next;
}
