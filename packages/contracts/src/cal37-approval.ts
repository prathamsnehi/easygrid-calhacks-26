/**
 * CAL-37: pure, auditable SIMULATED approval and first-tranche settlement.
 * Caller MUST load authoritative CAL-29 current state and commit returned state
 * with a transactional compare-and-swap. This module never transfers funds.
 */
import { createHash } from 'node:crypto';
import { buildCal36FromOwnerHandoff, finalizeCal36ApprovalPackage, type Cal36ApprovalPackage } from './cal36-shared-handoff.ts';
import { type DemoAgreementPackage, EasementError } from './cal36-easement.ts';
import { assertAgreementReady, createSettlementPlan, settlementObligationId, type CurrentHandoffState, type OwnerHandoff } from './owner-handoff.ts';

export type Cal37Approval = {
  approvalId:string; managerAlias:string; operatorAlias:string; approvedAt:string; simulated:true;
  sessionId:string; projectId:string; routeId:string; routeVersion:number;
  revision:number; packageHash:string;
  termsVersions:Record<string,number>; contractVersions:Record<string,number>;
};
export type Cal37LedgerEntry = {
  obligationId:string; approvalId:string; sessionId:string; projectId:string;
  routeId:string; routeVersion:number; parcelId:string; ownerId:string;
  contractId:string; contractVersion:number; termsVersion:number;
  paymentRecipientRef:string; recipientDisplay:string; amountCents:number;
  status:'attempted'|'paid'; attemptedAt:string; paidAt?:string;
  receiptId?:string; simulated:true;
};
export type Cal37State = {
  revision:number; approval:Cal37Approval|null; ledger:Cal37LedgerEntry[];
};
export type Cal37Receipt = {
  receiptId:string; obligationId:string; approvalId:string; parcelId:string;
  amountCents:number; currency:'USD'; recipientDisplay:string;
  status:'simulated_paid'; simulated:true;
  label:'SIMULATED PAYMENT — NO REAL FUNDS TRANSFERRED';
};
export const emptyCal37State=():Cal37State=>({revision:0,approval:null,ledger:[]});
const validText=(s:string)=>typeof s==='string'&&s.trim().length>0;
const stamp=(s:string)=>validText(s)&&!Number.isNaN(Date.parse(s));
const fail=(code:string,message:string):never=>{throw new EasementError(code,message);};
const stableId=(...parts:unknown[])=>'sim-'+createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0,24);
function checkUnique(state:Cal37State) {
 if(!Number.isSafeInteger(state.revision)||state.revision<0)fail('INVALID_INPUT','Invalid state revision');
 const ids=state.ledger.map(e=>e.obligationId);
 if(new Set(ids).size!==ids.length)fail('BLOCKED_STATE','Duplicate business obligations in authoritative ledger');
}
function assertCurrentApproval(packet:OwnerHandoff,current:CurrentHandoffState,approval:Cal37Approval) {
 assertAgreementReady(packet,current);
 if(approval.sessionId!==current.sessionId||approval.projectId!==current.projectId||
    approval.routeId!==current.routeId||approval.routeVersion!==current.routeVersion||
    approval.revision!==current.revision ||
    Object.keys(approval.termsVersions).length!==packet.parcels.length||
    packet.parcels.some(p=>approval.termsVersions[p.parcelId]!==p.terms.termsVersion))
   fail('STALE_VERSION','Approval no longer matches authoritative route or terms');
}
/** Explicit operator approval is separate from the owner's simulated signatures. */
export function approveCal37(input:{
 packet:OwnerHandoff; current:CurrentHandoffState;
 issued:Cal36ApprovalPackage; signed:DemoAgreementPackage; operatorAlias:string;
 managerAlias:string; managerConfirmed:boolean; approvedAt:string;
 state:Cal37State; expectedStateRevision:number;
}):Cal37State {
 const {packet,current,state}=input;checkUnique(state);
 if(state.revision!==input.expectedStateRevision)fail('STALE_VERSION','Concurrent state revision changed');
 if(state.approval||state.ledger.length)fail('BLOCKED_STATE','Approval already exists; cannot replace or replay');
 if(!input.managerConfirmed||!validText(input.managerAlias)||!stamp(input.approvedAt))
   fail('BLOCKED_STATE','Explicit manager confirmation, alias and timestamp required');
 const authoritative=assertAgreementReady(packet,current);
 const expected=buildCal36FromOwnerHandoff(authoritative,current,input.operatorAlias);
 if(input.issued.packageHash!==expected.packageHash||
    input.issued.agreementPackage.packageHash!==expected.packageHash)
   fail('STALE_VERSION','Issued agreements do not match current accepted terms');
 const finalized=finalizeCal36ApprovalPackage(input.issued,input.signed);
 if(!finalized.readyForApproval)fail('BLOCKED_STATE','All owner signatures required');
 const signedById=new Map(finalized.agreementPackage.agreements.map(a=>[a.id,a]));
 if(signedById.size!==expected.agreementPackage.agreements.length||
    expected.agreementPackage.agreements.some(a=>{
      const s=signedById.get(a.id);
      return !s||s.contentHash!==a.contentHash||s.ownerId!==a.ownerId||
        s.compensationCents!==a.compensationCents||s.monthlyRentCents!==a.monthlyRentCents||
        s.paymentRecipientRef!==a.paymentRecipientRef;
    }))fail('STALE_VERSION','Signed contracts differ from authoritative accepted terms');
 const termsVersions=Object.fromEntries(packet.parcels.map(p=>[p.parcelId,p.terms.termsVersion]));
 const contractVersions=Object.fromEntries(input.signed.agreements.map(a=>[a.id,a.contractVersion]));
 const approvalId=stableId(packet.sessionId,packet.routeId,current.revision,expected.packageHash,input.managerAlias);
 return {revision:state.revision+1,ledger:[],approval:{
  approvalId,managerAlias:input.managerAlias,operatorAlias:input.operatorAlias,approvedAt:input.approvedAt,simulated:true,
  sessionId:packet.sessionId,projectId:packet.projectId,routeId:packet.routeId,
  routeVersion:packet.routeVersion,revision:current.revision,
  packageHash:expected.packageHash,termsVersions,contractVersions
 }};
}
/** A failed attempt is visible but not paid. A successful retry reuses the SAME obligation ID. */
export function settleCal37(input:{
 packet:OwnerHandoff;current:CurrentHandoffState;signed:DemoAgreementPackage;
 state:Cal37State;expectedStateRevision:number;attemptedAt:string;
 outcome:'simulated_success'|'simulated_failure';requestKey:string;
}):{state:Cal37State;receipts:Cal37Receipt[];attempted:Cal37LedgerEntry[];alreadyPaid:string[]} {
 const {packet,current,state}=input;checkUnique(state);
 if(state.revision!==input.expectedStateRevision)fail('STALE_VERSION','Concurrent state revision changed');
 if(!state.approval)fail('BLOCKED_STATE','Explicit manager approval required');
 if(!stamp(input.attemptedAt)||!validText(input.requestKey))fail('INVALID_INPUT','Attempt timestamp and request key required');
 const approval=state.approval;
 assertCurrentApproval(packet,current,approval);
 if(input.signed.packageHash!==approval.packageHash)fail('STALE_VERSION','Package hash changed after approval');
 const rebuilt=buildCal36FromOwnerHandoff(packet,current,approval.operatorAlias);
 if(rebuilt.packageHash!==approval.packageHash)fail('STALE_VERSION','Approved package no longer matches accepted terms');
 const original=rebuilt.agreementPackage.agreements;
 if(input.signed.agreements.length!==original.length)fail('BLOCKED_STATE','Incomplete contracts');
 const signedMap=new Map(input.signed.agreements.map(a=>[a.id,a]));
 if(signedMap.size!==original.length||original.some(a=>{
  const s=signedMap.get(a.id);
  return !s||s.contentHash!==a.contentHash||s.status!=='demo_signed'||
   s.signature?.contentHash!==a.contentHash||s.signature?.routeVersion!==current.routeVersion||
   s.signature?.termsVersion!==a.termsVersion||s.signature?.contractVersion!==a.contractVersion||
   s.signature?.agreementId!==a.id||s.signature?.simulated!==true;
 }))fail('BLOCKED_STATE','Current complete signed contracts required');
 const owners=new Map(packet.owners.map(o=>[o.ownerId,o]));
 const paid=state.ledger.filter(e=>e.status==='paid');
 const contracts=input.signed.agreements.map(a=>({
  sessionId:packet.sessionId,projectId:packet.projectId,routeId:packet.routeId,
  routeVersion:packet.routeVersion,parcelId:a.parcelId,ownerId:a.ownerId,
  contractId:a.id,contractVersion:a.contractVersion,termsVersion:a.termsVersion,
  demoSigned:true,paymentRecipientRef:a.paymentRecipientRef??'',
  compensationCents:a.compensationCents,monthlyRentCents:a.monthlyRentCents,
  rentHorizonMonths:packet.rentHorizonMonths
 }));
 const settledObligations=paid.map(e=>{
  const p=packet.parcels.find(p=>p.parcelId===e.parcelId)!;
  return {obligationId:e.obligationId,sessionId:e.sessionId,projectId:e.projectId,
   routeId:e.routeId,routeVersion:e.routeVersion,parcelId:e.parcelId,ownerId:e.ownerId,
   paymentRecipientRef:e.paymentRecipientRef,termsVersion:e.termsVersion,
   compensationCents:p.terms.compensationCents,monthlyRentCents:p.terms.monthlyRentCents,
   amountCents:e.amountCents,rentHorizonMonths:packet.rentHorizonMonths,
   completionId:null,completedOn:null};
 });
 const alreadyPaid=paid.map(e=>e.obligationId);
 if(alreadyPaid.length===packet.parcels.length)fail('BLOCKED_STATE','All 20% obligations already paid');
 const plan=createSettlementPlan(packet,{current,approvalId:approval.approvalId,approved:true,
  approvedPackage:{sessionId:approval.sessionId,projectId:approval.projectId,
   routeId:approval.routeId,routeVersion:approval.routeVersion,
   termsVersions:approval.termsVersions,contractVersions:approval.contractVersions},
  contracts,stage:'contract_tranche',asOfDate:input.attemptedAt.slice(0,10),
  completion:null,settledObligations});
 const updated=[...state.ledger],attempted:Cal37LedgerEntry[]=[],receipts:Cal37Receipt[]=[];
 for(const e of plan.entries){
  const owner=owners.get(e.ownerId);
  if(!owner||owner.banking.ownerId!==e.ownerId||
     owner.banking.paymentRecipientRef!==e.paymentRecipientRef||
     owner.banking.mode!=='simulated')fail('INVALID_RECIPIENT','Mock banking owner/destination mismatch');
  const existing=updated.findIndex(v=>v.obligationId===e.obligationId);
  if(existing>=0&&updated[existing]!.status==='paid')fail('BLOCKED_STATE','Already paid business obligation');
  const paidNow=input.outcome==='simulated_success';
  const entry:Cal37LedgerEntry={
   obligationId:e.obligationId,approvalId:approval.approvalId,
   sessionId:packet.sessionId,projectId:packet.projectId,routeId:packet.routeId,
   routeVersion:packet.routeVersion,parcelId:e.parcelId,ownerId:e.ownerId,
   contractId:e.contractId,contractVersion:e.contractVersion,termsVersion:e.termsVersion,
   paymentRecipientRef:e.paymentRecipientRef,
   recipientDisplay:owner.banking.bankDisplay+' '+owner.banking.accountDisplay,
   amountCents:e.amountCents,status:paidNow?'paid':'attempted',
   attemptedAt:input.attemptedAt,...(paidNow?{
    paidAt:input.attemptedAt,receiptId:stableId(approval.approvalId,e.obligationId)
   }:{}),simulated:true
  };
  if(existing>=0)updated[existing]=entry;else updated.push(entry);
  attempted.push(entry);
  if(paidNow)receipts.push({receiptId:entry.receiptId!,obligationId:entry.obligationId,
   approvalId:approval.approvalId,parcelId:entry.parcelId,amountCents:entry.amountCents,
   currency:'USD',recipientDisplay:entry.recipientDisplay,status:'simulated_paid',
   simulated:true,label:'SIMULATED PAYMENT — NO REAL FUNDS TRANSFERRED'});
 }
 const total=attempted.reduce((n,e)=>n+BigInt(e.amountCents),0n);
 if(total!==BigInt(plan.totalCents))fail('INVALID_AMOUNT','Per-parcel ledger does not reconcile to approved 20%');
 return {state:{revision:state.revision+1,approval,ledger:updated},
  attempted,receipts,alreadyPaid};
}
/** Preview-only: never expose a bank account beyond its synthetic masked display. */
export function cal37Status(state:Cal37State){
 return {approval:state.approval?'approved':'not_approved',
  attempted:state.ledger.filter(e=>e.status==='attempted').length,
  paid:state.ledger.filter(e=>e.status==='paid').length,
  simulated:true,label:'SIMULATED LEDGER — NO REAL FUNDS TRANSFERRED'};
}
