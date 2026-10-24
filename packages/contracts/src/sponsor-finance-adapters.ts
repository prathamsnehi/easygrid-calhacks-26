/** Optional sponsor integrations; never move funds or replace CAL-29 authoritative ledger. */
import { type Cal37State, cal37PublicView } from './cal37-approval.ts';
import { type LaterState, laterPublicView } from './cal38-39-settlement.ts';
import { EasementError } from './cal36-easement.ts';
export type SponsorAudit = {simulated:true;stage:string;approval:string;expectedCents:number;
 paidCents:number;unmatchedCents:number;discrepantCents:number;exceptions:string[];
 label:'SIMULATED PAYMENT — NO REAL FUNDS TRANSFERRED'};
/** Deterministic finance-agent input: a separate AI provider may explain exceptions,
 * but MUST NOT authorize or mutate approved payments.
 */
export function hyphenateFinanceAudit(first:Cal37State,later:LaterState):SponsorAudit{
 const view=laterPublicView(later),initial=cal37PublicView(first);
 const exceptions:string[]=[];
 if(!first.approval)exceptions.push('Manager approval missing');
 if(initial.attempted)exceptions.push('Initial settlement contains failed attempts');
 if(!later.completion)exceptions.push('Completion not recorded');
 if(view.unmatchedCents)exceptions.push('Outstanding simulated obligations');
 if(view.discrepantCents)exceptions.push('Monthly reconciliation discrepancy');
 return {simulated:true,stage:later.completion?'post_completion':'pre_completion',
  approval:initial.approval,expectedCents:view.expectedCents,
  paidCents:view.paidCents,unmatchedCents:view.unmatchedCents,
  discrepantCents:view.discrepantCents,exceptions,
  label:'SIMULATED PAYMENT — NO REAL FUNDS TRANSFERRED'};
}
/** Capital One Nessie sandbox read-only account verification adapter.
 * An actual request requires a valid Nessie API key and sandbox account ID.
 * Synthetic EasyGrid recipient refs are NOT Nessie account IDs.
 * Do not call transfer/deposit/withdrawal endpoints.
 */
export async function verifyNessieSandboxAccount(input:{
 baseUrl:string;apiKey:string;sandboxAccountId:string;
 fetcher:typeof fetch;
}):Promise<{provider:'capital-one-nessie';verified:boolean;accountId:string;simulated:true}>{
 const {baseUrl,apiKey,sandboxAccountId,fetcher}=input;
 if(!/^https:\/\//.test(baseUrl)||new URL(baseUrl).hostname!=='api.nessieisreal.com'&&new URL(baseUrl).hostname!=='api.reimaginebanking.com'||!apiKey||!sandboxAccountId||
 !/^[a-zA-Z0-9_-]+$/.test(sandboxAccountId))
 throw new EasementError('INVALID_INPUT','Valid HTTPS Nessie sandbox configuration required');
 const url=new URL(baseUrl.replace(/\/$/,'')+'/accounts/'+encodeURIComponent(sandboxAccountId));
 url.searchParams.set('key',apiKey);
 const response=await fetcher(url.toString(),{method:'GET',redirect:'error'});
 if(!response.ok)throw new EasementError('BLOCKED_STATE','Nessie sandbox account lookup failed');
 const data:unknown=await response.json();
 if(!data||typeof data!=='object'||!('_id' in data)||
 (data as {_id?:unknown})._id!==sandboxAccountId)
 throw new EasementError('BLOCKED_STATE','Nessie response account ID mismatch');
 return {provider:'capital-one-nessie',verified:true,accountId:sandboxAccountId,simulated:true};
}
