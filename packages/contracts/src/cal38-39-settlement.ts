/** CAL-37/38/39 handoff: one approved owner/recipient linkage, no standalone service. */
import {type Cal37State,cal37PublicView} from './cal37-approval.ts';
import {type OwnerHandoff,settlementObligationId,splitCompensation,monthlyFeeDueDate} from './owner-handoff.ts';
export type FollowupStage='completion_balance'|'monthly_fee';
export type FollowupEntry={obligationId:string;stage:FollowupStage;parcelId:string;ownerId:string;
 paymentRecipientRef:string;recipientDisplay:string;amountCents:number;paidCents:number;
 period:string|null;status:'attempted'|'paid'|'discrepant';simulated:true;
 label:'SIMULATED PAYMENT — NO REAL FUNDS TRANSFERRED'};
export type FollowupState={revision:number;completedOn:string|null;entries:FollowupEntry[]};
export const emptyFollowupState=():FollowupState=>({revision:0,completedOn:null,entries:[]});
const fail=(m:string):never=>{throw Error(m)};
function verify(packet:OwnerHandoff,first:Cal37State,state:FollowupState,revision:number){
 if(revision!==state.revision)fail('Stale authoritative revision');
 const approval=first.approval;
 if(!approval||approval.sessionId!==packet.sessionId||
 approval.routeId!==packet.routeId||approval.routeVersion!==packet.routeVersion)
 fail('Current manager approval required');
 if(first.ledger.length!==packet.parcels.length)fail('All 20% payments required');
 for(const p of packet.parcels){
 const owner=packet.owners.find(o=>o.ownerId===p.ownerId);
 const entry=first.ledger.find(e=>e.parcelId===p.parcelId);
 if(!owner||!entry||entry.status!=='paid'||entry.ownerId!==owner.ownerId||
 entry.paymentRecipientRef!==owner.banking.paymentRecipientRef||
 entry.amountCents!==splitCompensation(p.terms.compensationCents).contractTrancheCents||
 entry.obligationId!==settlementObligationId(packet.sessionId,p.parcelId,'contract_tranche')||
 approval.termsVersions[p.parcelId]!==p.terms.termsVersion)fail('Invalid approved owner or first tranche');
 }
 const seen=new Set<string>();
 for(const e of state.entries){
 const p=packet.parcels.find(p=>p.parcelId===e.parcelId);
 const o=p&&packet.owners.find(o=>o.ownerId===p.ownerId);
 if(!p||!o||seen.has(e.obligationId)||e.ownerId!==o.ownerId||
 e.paymentRecipientRef!==o.banking.paymentRecipientRef||
 e.recipientDisplay!==o.banking.bankDisplay+' '+o.banking.accountDisplay||
 e.simulated!==true||e.label!=='SIMULATED PAYMENT — NO REAL FUNDS TRANSFERRED')
 fail('Tampered or duplicate followup ledger');
 seen.add(e.obligationId);
 }
}
export function completeSimulated(packet:OwnerHandoff,first:Cal37State,state:FollowupState,
 expectedRevision:number,completedOn:string,confirmed:boolean):FollowupState{
 verify(packet,first,state,expectedRevision);
 if(!confirmed||state.completedOn)fail('Explicit unique completion confirmation required');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(completedOn))fail('Invalid completion date');
 return {...state,revision:state.revision+1,completedOn};
}
export function settleFollowup(packet:OwnerHandoff,first:Cal37State,state:FollowupState,
 expectedRevision:number,request:{stage:FollowupStage;asOfDate:string;monthlyIndex?:1|2;
 outcome:'simulated_success'|'simulated_failure'|'simulated_mismatch'}):FollowupState{
 verify(packet,first,state,expectedRevision);
 if(!state.completedOn||request.asOfDate<state.completedOn)fail('Completion required');
 if(request.stage==='monthly_fee'&&request.monthlyIndex===undefined)fail('Monthly index required');
 if(request.stage==='completion_balance'&&request.monthlyIndex!==undefined)fail('Balance cannot have month');
 if(request.stage==='monthly_fee'&&state.entries.filter(e=>e.stage==='completion_balance'&&e.status==='paid').length!==packet.parcels.length)
 fail('80% balances must settle before rent');
 const completedOn=state.completedOn;
 const due=request.stage==='monthly_fee'?monthlyFeeDueDate(completedOn,request.monthlyIndex!):completedOn;
 if(request.asOfDate<due)fail('Payment not yet due');
 const period=request.stage==='monthly_fee'?due.slice(0,7):null;
 const entries=[...state.entries];let changes=0;
 for(const p of packet.parcels){
 const owner=packet.owners.find(o=>o.ownerId===p.ownerId)!;
 const obligationId=settlementObligationId(packet.sessionId,p.parcelId,request.stage,period??undefined);
 const old=entries.findIndex(e=>e.obligationId===obligationId);
 if(old>=0&&entries[old]!.status==='paid')continue;
 const amountCents=request.stage==='monthly_fee'?p.terms.monthlyRentCents:
 splitCompensation(p.terms.compensationCents).completionBalanceCents;
 const paidCents=request.outcome==='simulated_success'?amountCents:
 request.outcome==='simulated_mismatch'?Math.max(0,amountCents-1):0;
 const row:FollowupEntry={obligationId,stage:request.stage,parcelId:p.parcelId,ownerId:p.ownerId,
 paymentRecipientRef:owner.banking.paymentRecipientRef,
 recipientDisplay:owner.banking.bankDisplay+' '+owner.banking.accountDisplay,
 amountCents,paidCents,period,status:paidCents===amountCents?'paid':paidCents===0?'attempted':'discrepant',
 simulated:true,label:'SIMULATED PAYMENT — NO REAL FUNDS TRANSFERRED'};
 if(old>=0)entries[old]=row;else entries.push(row);
 changes++;
 }
 if(!changes)fail('Duplicate payment: all obligations already paid');
 return {...state,revision:state.revision+1,entries};
}
export function publicSettlementView(first:Cal37State,state:FollowupState){
 const safe=state.entries.map(e=>({obligationId:e.obligationId,stage:e.stage,parcelId:e.parcelId,
 period:e.period,amountCents:e.amountCents,paidCents:e.paidCents,
 unmatchedCents:e.amountCents-e.paidCents,status:e.status,recipientDisplay:e.recipientDisplay,
 simulated:true,label:e.label}));
 const sum=(rows:typeof safe)=>({expectedCents:rows.reduce((n,e)=>n+e.amountCents,0),
 paidCents:rows.reduce((n,e)=>n+e.paidCents,0),unmatchedCents:rows.reduce((n,e)=>n+e.amountCents-e.paidCents,0)});
 return {simulated:true,label:'SIMULATED LEDGER — NO REAL FUNDS TRANSFERRED',
 first:cal37PublicView(first),completedOn:state.completedOn,revision:state.revision,entries:safe,
 balance:sum(safe.filter(e=>e.stage==='completion_balance')),
 monthly:sum(safe.filter(e=>e.stage==='monthly_fee'))};
}

/** CAL-29 adapter: commit a whole followup transition atomically; no parallel source of truth. */
export interface FollowupStore {
 load(sessionId:string):Promise<{packet:OwnerHandoff;first:Cal37State;state:FollowupState}>;
 compareAndSwap(sessionId:string,expectedRevision:number,next:FollowupState):Promise<boolean>;
}
export async function settleFollowupAuthoritatively(store:FollowupStore,sessionId:string,
 action:(packet:OwnerHandoff,first:Cal37State,state:FollowupState,revision:number)=>FollowupState){
 const snapshot=await store.load(sessionId);
 if(snapshot.packet.sessionId!==sessionId)fail('Authoritative session mismatch');
 const next=action(snapshot.packet,snapshot.first,snapshot.state,snapshot.state.revision);
 if(!await store.compareAndSwap(sessionId,snapshot.state.revision,next))
 fail('Concurrent authoritative ledger update rejected');
 return next;
}
