/** CAL-36–39 UI adapter in Theo's existing parcel analysis panel.
 * Isolated browser-only, explicit fixture simulation. No backend, bank or sponsor API.
 */
const DEMO_DATE='2026-10-24';
const money=c=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(c/100);
const copy=v=>JSON.parse(JSON.stringify(v));
const invalid=m=>{throw Error(m)};
const assert=(ok,m)=>{if(!ok)invalid(m)};
const monthDue=(anchor,i)=>{
 const [y,m,d]=anchor.split('-').map(Number);
 const z=new Date(Date.UTC(y,m-1+i,1));const end=new Date(Date.UTC(z.getUTCFullYear(),z.getUTCMonth()+1,0)).getUTCDate();
 return [z.getUTCFullYear(),String(z.getUTCMonth()+1).padStart(2,'0'),String(Math.min(d,end)).padStart(2,'0')].join('-');
};
const obligation=(parcelId,stage,period='')=>JSON.stringify([parcelId,stage,period]);
export function financeHandoffView(handoff){
 assert(handoff?.kind==='easygrid-map-handoff'&&handOffParcels(handoff).length>0,'Select and analyze a transmission route first.');
 const route=handoff.snapshot.routes.find(r=>r.id===handoff.snapshot.project.selectedRouteId)||handoff.snapshot.routes[0];
 assert(route&&route.parcelIds.length>0,'Missing selected route');
 const parcels=handOffParcels(handoff).map((p,i)=>{
  assert(typeof p.upfrontCents==='number'&&Number.isSafeInteger(p.upfrontCents)&&p.upfrontCents>=0,'Invalid route compensation');
  assert(typeof p.monthlyRentEquivalentCents==='number'&&Number.isSafeInteger(p.monthlyRentEquivalentCents)&&p.monthlyRentEquivalentCents>=0,'Invalid rent');
  return {id:p.parcelId,ownerId:p.ownerId,alias:p.ownerAlias,comp:p.upfrontCents,
   rent:p.monthlyRentEquivalentCents,rentApproximate:p.monthlyRentIsApproximate===true,landUse:p.landUse||'Fictional property',termsVersion:1,account:'NOT CONNECTED'};
 });
 assert(new Set(parcels.map(p=>p.id)).size===parcels.length,'Duplicate parcel IDs');
 assert(new Set(parcels.map(p=>p.ownerId)).size<=parcels.length,'Invalid owners');
 return {key:JSON.stringify([handoff.sessionId,route.id,handoff.routeVersion,parcels.map(p=>[p.id,p.ownerId,p.comp,p.rent,p.rentApproximate])]),
  sessionId:handoff.sessionId,routeId:route.id,routeVersion:handoff.routeVersion,source:'map-estimate-not-approved',parcels};
}
function handOffParcels(h){return Array.isArray(h?.parcelAnalysis)?h.parcelAnalysis:[]}
export function emptyFinanceState(view){return {key:view.key,revision:0,prepared:false,signed:[],approved:false,first:false,
 completion:null,balance:false,month:0,ledger:[],contractVersion:1,signatureReceipts:{},managerReceipt:null,attempts:[]}}
export function financeAction(view,prev,action){
 assert(prev?.key===view.key,'Route, version or agreed amounts changed. Reset settlement simulation.');
 const s=copy(prev),ids=new Set(view.parcels.map(p=>p.id));
 s.contractVersion??=1;s.signatureReceipts??={};s.attempts??=[];
 const record=(stage,fail=false,mismatch=false,period='')=>{
  let added=0;
  for(const p of view.parcels){
   const key=obligation(p.id,stage,period),existing=s.ledger.find(x=>x.id===key);
   if(existing?.status==='paid'||existing?.status==='discrepant')continue;
   const expected=stage==='20%'?Math.floor(p.comp/5):stage==='80%'?p.comp-Math.floor(p.comp/5):p.rent;
   const amount=fail?0:mismatch&&p.id===view.parcels[0].id?Math.max(0,expected-5000):expected;
   const row={id:key,parcelId:p.id,stage,period,expected,amount,status:fail?'attempted':amount===expected?'paid':'discrepant',
    receipt:fail?null:'SIM-'+String(s.ledger.length+1).padStart(4,'0'),simulated:true};
   if(existing)Object.assign(existing,row);else s.ledger.push(row);
   s.attempts.push({obligationId:key,stage,parcelId:p.id,status:row.status,simulated:true,sequence:s.attempts.length+1});
   added++;
  }
  assert(added>0,'All eligible obligations are already recorded');
 };
 if(action==='prepare'){
  assert(!s.prepared,'Fixture terms already prepared');
  // Does not assert landowner consent or negotiation result.
  s.prepared=true;
 }else if(action==='regenerate'){
  assert(s.prepared&&!s.approved,'Only unapproved fictional agreements can be regenerated');
  s.contractVersion++;s.signed=[];s.signatureReceipts={};
 }else if(action.startsWith('sign:')){
  const id=action.slice(5);assert(s.prepared&&!s.approved&&ids.has(id),'Prepare terms and choose a valid unsigned parcel');
  assert(!s.signed.includes(id),'Signature already simulated');
  s.signed.push(id);
  s.signatureReceipts[id]={parcelId:id,routeId:view.routeId,routeVersion:view.routeVersion,contractVersion:s.contractVersion,
   receipt:'SIM-SIGN-'+s.contractVersion+'-'+id,simulated:true};
 }else if(action==='approve'){
  assert(s.prepared&&s.signed.length===view.parcels.length&&view.parcels.every(p=>s.signed.includes(p.id)),'Every current fictional agreement needs a simulated signature');
  assert(!s.approved,'Already approved');
  assert(view.parcels.every(p=>s.signatureReceipts[p.id]?.contractVersion===s.contractVersion&&s.signatureReceipts[p.id]?.routeVersion===view.routeVersion),'Signed contract or route version is stale');
  s.approved=true;s.managerReceipt={id:'SIM-APPROVAL-'+s.contractVersion,routeVersion:view.routeVersion,contractVersion:s.contractVersion,simulated:true};
 }else if(action==='first'||action==='first-fail'){
  assert(s.approved&&!s.first,'Current manager approval and unsettled 20% required');
  record('20%',action.endsWith('fail'));if(action==='first')s.first=true;
 }else if(action==='complete'){
  assert(s.prepared&&s.approved&&s.first&&s.signed.length===view.parcels.length,'Missing current signatures, manager approval or successful 20% tranche');
  assert(!s.completion,'Completion already recorded');s.completion=DEMO_DATE;
 }else if(action==='balance'||action==='balance-fail'){
  assert(s.completion&&s.first&&!s.balance,'Completed construction and unpaid 80% required');
  record('80%',action.endsWith('fail'));if(action==='balance')s.balance=true;
 }else if(action==='advance'){
  assert(s.completion&&s.month<2,'Complete construction first; at most two rental months');
  if(s.month===1)assert(view.parcels.every(p=>s.ledger.some(x=>x.id===obligation(p.id,'rent',monthDue(s.completion,1).slice(0,7)))),'Record first monthly obligations before advancing');
  s.month++;
 }else if(['rent','rent-fail','mismatch'].includes(action)){
  assert(s.completion&&s.month>0,'No monthly rent before completion and due date');
  record('rent',action==='rent-fail',action==='mismatch',monthDue(s.completion,s.month).slice(0,7));
 }else invalid('Unknown finance action');
 s.revision++;
 return s;
}
export function financeTotals(s){
 return {expected:s.ledger.reduce((n,r)=>n+r.expected,0),
 paid:s.ledger.filter(r=>r.status==='paid').reduce((n,r)=>n+r.amount,0),
 unmatched:s.ledger.filter(r=>r.status==='attempted').reduce((n,r)=>n+r.expected,0),
 discrepant:s.ledger.filter(r=>r.status==='discrepant').reduce((n,r)=>n+Math.abs(r.expected-r.amount),0)};
}
export function mountFinancePanel(){
 const root=document.querySelector('#finance-workflow');
 if(!root||!window.easygridDemo)return;
 let view=null,s=null;
 const storageKey='easygrid-finance-demo-v1';
 const btn=(label,action,enabled)=>{const b=document.createElement('button');b.type='button';b.className='secondary-button finance-button';b.textContent=label;b.disabled=!enabled;b.addEventListener('click',()=>go(action));return b};
 const div=(tag,text,klass)=>{const x=document.createElement(tag);x.textContent=text||'';if(klass)x.className=klass;return x};
 const group=(parent,title)=>{const box=div('section','','finance-stage');box.append(div('h4',title));parent.append(box);return box};
 const row=(parent,label,value)=>{const x=div('div','','finance-entry');x.append(div('span',label),div('strong',value));parent.append(x)};
 const controls=(parent,items)=>{const x=div('div','','finance-controls');for(const item of items)x.append(btn(...item));parent.append(x)};
 const status=document.querySelector('#finance-message'),content=document.querySelector('#finance-content');
 const notify=(msg,error=false)=>{status.textContent=msg;status.dataset.error=String(error)};
 function current(){
  const handoff=window.easygridDemo.getHandoff();
  return financeHandoffView(handoff);
 }
 function refresh(){
  try{
   const next=current();
   if(!view||next.key!==view.key){
    view=next;
    // No personal info is persisted; only route signature and fictional settlement records.
    let loaded=null;try{loaded=JSON.parse(sessionStorage.getItem(storageKey)||'null')}catch{}
    s=loaded?.key===view.key&&Array.isArray(loaded.ledger)&&Array.isArray(loaded.signed)?loaded:emptyFinanceState(view);
    if(s.key!==view.key)s=emptyFinanceState(view);
   }
   render();return true;
  }catch(e){view=null;s=null;content.replaceChildren(div('p',e.message,'analysis-footnote'));return false}
 }
 function go(action){
  try{
   const next=current();
   if(!view||next.key!==view.key){view=next;s=emptyFinanceState(view);notify('Route or terms changed. Previous demo state invalidated.',true);render();return}
   if(action==='reset'){s=emptyFinanceState(view)}
   else s=financeAction(view,s,action);
   try{sessionStorage.setItem(storageKey,JSON.stringify(s))}catch{}
   notify(action==='reset'?'Synthetic finance demo reset.':'Fixture action recorded: '+action);
   render();
  }catch(e){notify(e.message,true)}
 }
 function render(){
  if(!view||!s)return;content.replaceChildren();
  const head=div('div','','finance-overview');
  const comp=view.parcels.reduce((n,p)=>n+p.comp,0),rent=view.parcels.reduce((n,p)=>n+p.rent,0);
  row(head,'UNAPPROVED ROUTE ESTIMATE · fictional',money(comp));row(head,'20% initial tranche',money(view.parcels.reduce((n,p)=>n+Math.floor(p.comp/5),0)));
  row(head,'80% remaining balance',money(view.parcels.reduce((n,p)=>n+p.comp-Math.floor(p.comp/5),0)));
  row(head,'Monthly demo rent basis',money(rent));
  content.append(head);
  const first=group(content,'CAL-36 · Versioned agreements & simulated signatures');
  first.append(div('p','Owner negotiation is pending in the map. “Prepare fictional terms” is an explicit local demo override, NOT real owner consent or an authoritative approved package.','finance-note'));
  row(first,'Current route',view.routeId+' · v'+view.routeVersion);
  row(first,'Fictional agreement version','v'+s.contractVersion);
  controls(first,[['Prepare fictional accepted terms','prepare',!s.prepared],['Regenerate agreements (void signatures)','regenerate',s.prepared&&!s.approved]]);
  for(const p of view.parcels){
   const terms=financeContractPreview(view,s,p.id);
   const details=div('details','','finance-contract');details.append(div('summary','View '+p.id+' simulated easement agreement'));
   const body=div('pre',terms.text,'finance-contract-text');details.append(body);first.append(details);
   row(first,p.id+' · '+p.alias, money(p.comp)+' / month '+money(p.rent)+(p.rentApproximate?' (rounded estimate)':''));
   row(first,'Signature '+p.id,s.signatureReceipts[p.id]?.receipt??'Not signed');
   controls(first,[['Simulate '+p.id+' signature','sign:'+p.id,s.prepared&&!s.approved&&!s.signed.includes(p.id)]]);
  }
  const second=group(content,'CAL-37 · Manager approval and 20%');
  row(second,'Signed contracts',s.signed.length+' / '+view.parcels.length);
  row(second,'Manager approval',s.approved?'Approved (fixture) · '+s.managerReceipt?.id:'Not approved');
  row(second,'Contract tranche',s.first?'Paid (simulated)':'Not settled');
  controls(second,[['Approve current package','approve',s.prepared&&!s.approved&&s.signed.length===view.parcels.length],
   ['Simulate 20% payment','first',s.approved&&!s.first],['Show failed 20% attempt','first-fail',s.approved&&!s.first]]);
  const third=group(content,'CAL-38 · Construction completion and 80%');
  row(third,'Prerequisites',!s.prepared?'Missing terms':!s.approved?'Missing manager approval':!s.first?'Missing successful 20%':'Ready');
  row(third,'Completion',s.completion??'Not recorded');
  row(third,'Remaining balance',s.balance?'Paid (simulated)':'Not settled');
  controls(third,[['Simulate Completion','complete',s.approved&&s.first&&!s.completion],
   ['Simulate 80% payment','balance',!!s.completion&&!s.balance],['Show failed 80% attempt','balance-fail',!!s.completion&&!s.balance]]);
  const fourth=group(content,'CAL-39 · Recurring rent / two-month reconciliation');
  row(fourth,'Monthly clock',s.month?s.month+' / 2 · '+monthDue(s.completion,s.month):'No rent due before completion');
  const period=s.completion&&s.month?monthDue(s.completion,s.month).slice(0,7):'';
  const paidCurrent=s.month&&view.parcels.every(p=>s.ledger.some(x=>x.id===obligation(p.id,'rent',period)&&['paid','discrepant'].includes(x.status)));
  const canAdvance=s.completion&&s.month<2&&(s.month===0||view.parcels.every(p=>s.ledger.some(x=>x.id===obligation(p.id,'rent',period))));
  controls(fourth,[['Advance month','advance',!!canAdvance],['Simulate monthly payment','rent',!!s.month&&!paidCurrent],
   ['Show failed rent attempt','rent-fail',!!s.month&&!paidCurrent],['Inject $50 mismatch','mismatch',!!s.month&&!paidCurrent]]);
  const ledger=group(content,'Simulated payment ledger / reconciliation');
  const totals=financeTotals(s);
  for(const [label,value] of [['Expected',totals.expected],['Simulated paid (matched)',totals.paid],['Unmatched attempts',totals.unmatched],['Discrepancies',totals.discrepant]])row(ledger,label,money(value));
  for(const x of s.ledger)row(ledger,x.parcelId+' · '+x.stage+(x.period?' '+x.period:''),
    money(x.expected)+' expected / '+money(x.amount)+' recorded · '+x.status+(x.receipt?' · '+x.receipt:''));
  ledger.append(div('h4','Simulated attempt history (including failures)'));
  for(const item of s.attempts??[])row(ledger,'#'+item.sequence+' · '+item.parcelId+' · '+item.stage,item.status+' · '+item.obligationId);
  ledger.append(div('p','All receipts and bank destinations are simulated. No actual account or transfer. State is stored only in this browser tab, not in SpacetimeDB.','finance-note'));
  const monitor=group(content,'Hyphenate · AI finance monitoring');
  const audit=financeMonitoring(view,s);
  row(monitor,'Connection','NOT CONNECTED · rules-only preview');
  row(monitor,'Risk level',audit.level.toUpperCase());
  for(const issue of audit.issues)monitor.append(div('p','• '+issue,'finance-note'));
  monitor.append(div('p','Real Hyphenate AI execution requires a backend agent. This panel performs deterministic rule checks only; it cannot authorize a payment.','finance-note'));
  const bank=group(content,'Capital One Nessie · bank transaction evidence');
  row(bank,'Connection','NOT CONNECTED · sandbox credentials required');
  row(bank,'Bank transaction matches','UNVERIFIED');
  row(bank,'Approved payout recipient','Not supplied by SpacetimeDB');
  bank.append(div('p','Nessie sandbox account, transaction ID, expected amount, status and one-to-one obligation reconciliation will appear here when a server adapter is connected. Demo receipt IDs are NOT bank transfers.','finance-note'));
  controls(content,[['Reset local demo','reset',true]]);
 }
 document.querySelector('#finance-refresh').addEventListener('click',refresh);
 document.querySelector('#open-analysis')?.addEventListener('click',()=>refresh());
 document.querySelector('#recalculate-route')?.addEventListener('click',()=>{view=null;s=null;});
 document.querySelector('#finance-summary')?.addEventListener('click',refresh);
 refresh();
}

/** Renderable document preview; explicitly not an executed real contract. */
export function financeContractPreview(view,state,parcelId){
 const p=view.parcels.find(x=>x.id===parcelId);
 assert(p&&state.prepared,'Prepare fictional terms before reading an agreement.');
 const first=Math.floor(p.comp/5),balance=p.comp-first;
 const text=[
 'EASYGRID — SIMULATED EASEMENT AGREEMENT · NOT LEGALLY BINDING',
 'Project session: '+view.sessionId,
 'Selected route: '+view.routeId+' (version '+view.routeVersion+')',
 'Contract version: '+state.contractVersion,
 'Property: '+p.id+' / synthetic owner '+p.alias+' ('+p.ownerId+')',
 'Land use: '+p.landUse,
 'Access rights: fictional transmission corridor — requires actual owner consent',
 'Illustrative compensation (NOT negotiated/approved): '+money(p.comp),
 'On manager approval and signing: initial 20% '+money(first),
 'After simulated construction completion: remaining 80% '+money(balance),
 'No separate deposit; two tranches sum exactly to total compensation.',
 'Monthly fee (after recorded completion, 1 calendar month later): '+money(p.rent)+(p.rentApproximate?' [rounded non-contract estimate]':''),
 'Simulated signature receipt: '+(state.signatureReceipts?.[p.id]?.receipt??'NOT SIGNED'),
 'Bank account: NOT PROVIDED · NO REAL FUNDS TRANSFERRED',
 'Terms source: MAP ESTIMATE — NOT SPACETIMEDB APPROVED CONTRACT'
 ].join('\\n');
 return {parcelId:p.id,contractVersion:state.contractVersion,routeVersion:view.routeVersion,simulated:true,text};
}
/** Pure, explainable pre-integration alerts, NOT a connected Hyphenate provider. */
export function financeMonitoring(view,state){
 const issues=[];
 if(!state.prepared)issues.push('Accepted contract terms not received from authoritative backend.');
 if(state.prepared&&state.signed.length!==view.parcels.length)issues.push('Missing simulated owner signatures.');
 if(!state.approved)issues.push('Manager approval not recorded.');
 if(state.attempts?.some(a=>a.status==='attempted'))issues.push('Failed payment attempts require reconciliation/review.');
 const total=financeTotals(state);
 if(total.discrepant)issues.push('Monthly payment amount mismatch: '+money(total.discrepant)+'.');
 if(state.completion&&!state.first)issues.push('Completion exists without successful 20% payment — BLOCK.');
 issues.push('SpacetimeDB authorization and uniqueness are NOT verified.');
 return {level:total.discrepant?'blocked':state.attempts?.some(a=>a.status==='attempted')?'review':'pending',
  issues,source:'local-deterministic-rules',autoExecute:false,simulated:true};
}
