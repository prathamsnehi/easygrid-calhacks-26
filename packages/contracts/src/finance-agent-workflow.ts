/**
 * Sponsor-ready finance workflows, isolated from UI / CAL-29 authoritative writes.
 * Capital One Nessie: READ-ONLY sandbox transaction evidence.
 * Hyphenate-themed agent: autonomous exception triage, human-gated resolution proposal.
 * Neither function transfers money or changes a settlement ledger.
 */
import {EasementError} from './cal36-easement.ts';
import {type Cal37State} from './cal37-approval.ts';
import {type LaterState, laterPublicView} from './cal38-39-settlement.ts';
import {hyphenateFinanceAudit} from './sponsor-finance-adapters.ts';

const allowedHosts=new Set(['api.nessieisreal.com','api.reimaginebanking.com']);
const cents=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
type NessieRecord={_id?:string;amount?:number;status?:string;transaction_date?:string;description?:string};
export type NessieEvidence={
 source:'capital-one-nessie-sandbox';simulated:true;accountId:string;
 accountVerified:boolean;transactions:{id:string;type:'deposit'|'withdrawal';amountCents:number;status:string}[];
 note:'READ-ONLY SANDBOX — NOT PROOF OF EASYGRID PAYMENT';
};
/** Fetch actual Nessie account and posted deposit/withdrawal data in a trusted server.
 * API key must stay server-side; no external redirect, no mutation endpoints.
 * The records are merely independent sandbox evidence, never assumed to match obligations.
 */
export async function collectNessieEvidence(input:{
 baseUrl:string;apiKey:string;sandboxAccountId:string;fetcher:typeof fetch
}):Promise<NessieEvidence>{
 const {baseUrl,apiKey,sandboxAccountId,fetcher}=input;
 let u:URL;try{u=new URL(baseUrl)}catch{throw new EasementError('INVALID_INPUT','Invalid sandbox origin')}
 if(u.protocol!=='https:'||!allowedHosts.has(u.hostname)||u.username||u.password||u.port||u.pathname!=='/'||
  u.search||u.hash||!apiKey.trim()||!/^[A-Za-z0-9_-]+$/.test(sandboxAccountId))
  throw new EasementError('INVALID_INPUT','Official Nessie HTTPS sandbox origin and credentials required');
 async function get(path:string):Promise<unknown>{
  const url=new URL(path,u);
  url.searchParams.set('key',apiKey);
  const response=await fetcher(url.toString(),{method:'GET',redirect:'error'});
  if(!response.ok)throw new EasementError('BLOCKED_STATE','Nessie sandbox request unavailable');
  return response.json() as Promise<unknown>;
 }
 const account=await get('/accounts/'+encodeURIComponent(sandboxAccountId));
 if(!account||typeof account!=='object'||(account as {_id?:unknown})._id!==sandboxAccountId)
  throw new EasementError('BLOCKED_STATE','Nessie account identity mismatch');
 const output:NessieEvidence['transactions']=[];
 for(const kind of ['deposits','withdrawals'] as const){
  const raw=await get('/accounts/'+encodeURIComponent(sandboxAccountId)+'/'+kind);
  if(!Array.isArray(raw))throw new EasementError('BLOCKED_STATE','Invalid Nessie transaction response');
  for(const value of raw){
   if(!value||typeof value!=='object')throw new EasementError('BLOCKED_STATE','Invalid transaction row');
   const row=value as NessieRecord;
   // Nessie amounts are USD; convert only after checking exact integer cents.
   const scaled=typeof row.amount==='number'?Math.round(row.amount*100):NaN;
   if(typeof row._id!=='string'||!Number.isFinite(row.amount)||!cents(scaled)||
    Math.abs(scaled/100-row.amount!)>1e-8||typeof row.status!=='string')
    throw new EasementError('BLOCKED_STATE','Malformed sandbox transaction amount/status');
   output.push({id:row._id,type:kind==='deposits'?'deposit':'withdrawal',amountCents:scaled,status:row.status});
  }
 }
 if(new Set(output.map(t=>t.id)).size!==output.length)throw new EasementError('BLOCKED_STATE','Duplicate Nessie transaction IDs');
 return {source:'capital-one-nessie-sandbox',simulated:true,accountId:sandboxAccountId,
  accountVerified:true,transactions:output,
  note:'READ-ONLY SANDBOX — NOT PROOF OF EASYGRID PAYMENT'};
}
export type FinanceAgentDecision={
 agent:'easement-finance-reconciler';mode:'advisory_only';requiresHumanApproval:true;simulated:true;
 severity:'clear'|'review'|'blocked';actions:{id:string;kind:'request_evidence'|'review_discrepancy'|'retry_failed'|'await_approval'|'archive_receipt';
 reason:string;autoExecute:false}[];
 evidence:{firstRevision:number;laterRevision:number;sandboxVerified:boolean};
};
/** Autonomous deterministic policy agent, explainable and repeatable; no ledger mutation.
 * An external LLM can narrate this bounded result, not authorize money movement.
 */
export function planFinanceAgent(first:Cal37State,later:LaterState,nessie?:NessieEvidence):FinanceAgentDecision{
 const audit=hyphenateFinanceAudit(first,later),view=laterPublicView(later);
 const actions:FinanceAgentDecision['actions']=[];
 if(!first.approval)actions.push({id:'approval',kind:'await_approval',reason:'Require a current signed package and manager approval',autoExecute:false});
 if(first.ledger.some(r=>r.status==='attempted')||view.unmatchedCents>0)
  actions.push({id:'retry',kind:'retry_failed',reason:'An unpaid simulated obligation needs operator review and controlled retry',autoExecute:false});
 if(view.discrepantCents>0)
  actions.push({id:'reconciliation',kind:'review_discrepancy',reason:'Recorded simulated monthly amount differs from approved contract amount',autoExecute:false});
 if(!nessie?.accountVerified)actions.push({id:'nessie',kind:'request_evidence',reason:'No verified Capital One Nessie sandbox evidence; never infer a banking transfer',autoExecute:false});
 if(!actions.length&&later.completion&&audit.exceptions.length===0)
  actions.push({id:'receipt',kind:'archive_receipt',reason:'Synthetic audit is clear; human may export the labeled receipt',autoExecute:false});
 return {agent:'easement-finance-reconciler',mode:'advisory_only',requiresHumanApproval:true,simulated:true,
  severity:view.discrepantCents>0?'blocked':actions.some(a=>a.kind!=='archive_receipt')?'review':'clear',
  actions,evidence:{firstRevision:first.revision,laterRevision:later.revision,sandboxVerified:nessie?.accountVerified===true}};
}
