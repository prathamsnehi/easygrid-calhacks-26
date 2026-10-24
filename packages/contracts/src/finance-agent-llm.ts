/** Optional AI reasoning boundary for autonomous finance exception triage.
 * Never transmits private recipients, account IDs, contact details or credentials.
 * The model may annotate existing deterministic actions, NEVER invent or execute them.
 */
import {EasementError} from './cal36-easement.ts';
import {type Cal37State} from './cal37-approval.ts';
import {type LaterState} from './cal38-39-settlement.ts';
import {type NessieEvidence, planFinanceAgent} from './finance-agent-workflow.ts';
export type FinanceAIInsight={modelUsed:true;simulated:true;requiresHumanApproval:true;
 summary:string;rankedActionIds:string[];safeActions:{id:string;kind:string;reason:string;autoExecute:false}[]};
export interface FinanceReasoner{
 /** Supply a real configured LLM in server integration; never invoke from browser with API key. */
 explain(input:{severity:string;expectedActionIds:string[];policyReasons:string[]}):
  Promise<{summary:string;rankedActionIds:string[]}>;
}
/** Bounded AI decision-making: the deterministic rules are the authorization ceiling. */
export async function explainFinanceExceptions(
 first:Cal37State,later:LaterState,reasoner:FinanceReasoner,nessie?:NessieEvidence
):Promise<FinanceAIInsight>{
 const plan=planFinanceAgent(first,later,nessie);
 const payload={severity:plan.severity,expectedActionIds:plan.actions.map(a=>a.id),
  policyReasons:plan.actions.map(a=>a.reason)};
 const response=await reasoner.explain(payload);
 if(!response||typeof response.summary!=='string'||response.summary.length<1||response.summary.length>800||
  !Array.isArray(response.rankedActionIds)||response.rankedActionIds.some(id=>typeof id!=='string')||
  new Set(response.rankedActionIds).size!==response.rankedActionIds.length||
  response.rankedActionIds.length!==plan.actions.length||
  response.rankedActionIds.some(id=>!payload.expectedActionIds.includes(id)))
  throw new EasementError('BLOCKED_STATE','AI finance proposal failed action allowlist validation');
 const byId=new Map(plan.actions.map(a=>[a.id,a]));
 return {modelUsed:true,simulated:true,requiresHumanApproval:true,
  summary:response.summary,rankedActionIds:response.rankedActionIds,
  safeActions:response.rankedActionIds.map(id=>byId.get(id)!)};
}
