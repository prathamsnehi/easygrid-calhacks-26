import { settlementBinding } from './settlement-controller.js';
import { createOfferPolicy, negotiationLimitCents } from './offer-policy.js';

const copy=value=>JSON.parse(JSON.stringify(value));
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const requireState=(condition,message)=>{if(!condition)throw new Error(message);};
const cents=value=>Number.isSafeInteger(value)&&value>=0;
const version=value=>Number.isSafeInteger(value)&&value>=1;
const sameIds=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&new Set(a).size===a.length&&new Set(b).size===b.length&&a.every(id=>b.includes(id));
function sum(values){
  requireState(values.every(cents),'Simulated amounts must be nonnegative safe-integer cents.');
  const total=values.reduce((value,next)=>value+BigInt(next),0n);
  requireState(total<=BigInt(Number.MAX_SAFE_INTEGER),'Simulated total exceeds safe-integer cents.');
  return Number(total);
}
function rentFor(monthly,months){
  requireState(cents(monthly),'The simulated monthly fee must be exact integer cents.');
  const total=BigInt(monthly)*BigInt(months);
  requireState(total<=BigInt(Number.MAX_SAFE_INTEGER),'Simulated rent exceeds safe-integer cents.');
  return Number(total);
}

/**
 * Scripted acceptance by fictional owners after the original participant refuses.
 * No calls, signatures, approvals, ledger writes or canonical persistence occur.
 * The rounded planning fee becomes a NEW explicitly simulated exact monthly offer.
 */
export function createSimulatedAgreement(handoff,{blockedParcelIds=[]}={}){
  requireState(handoff?.kind==='easygrid-map-handoff'&&handoff.schemaVersion===2&&handoff.sourceMode==='fixture',
    'A current fixture map handoff is required for simulated agreements.');
  const original=handoff.ownerHandoff,project=handoff.snapshot?.project,route=handoff.snapshot?.routes?.[0],role=handoff.userRole;
  requireState(original?.kind==='easygrid-owner-handoff'&&original.schemaVersion===1&&original.sourceMode==='fixture'&&
    original.referenceBinding==='local-fixture'&&original.routeStatus==='selected_for_negotiation'&&original.simulationChecksPassed===true,
    'The route must be an eligible local proposal before simulated agreement.');
  requireState(route?.eligible===true&&route.sourceMode==='fixture'&&project?.sourceMode==='fixture'&&
    project.id===original.projectId&&route.projectId===original.projectId&&route.id===original.routeId&&
    project.selectedRouteId===route.id&&route.version===original.routeVersion&&handoff.routeVersion===route.version&&
    handoff.sessionId===original.sessionId&&version(route.version)&&version(original.rentHorizonMonths)&&original.rentHorizonMonths<=1200&&
    original.rentHorizonMonths===project.rentHorizonMonths&&original.budgetCents===project.budgetCents&&
    cents(original.budgetCents)&&cents(original.constructionCents)&&original.constructionCents===route.constructionCents,
    'The route, session, budget and rent horizon must match the current proposal.');
  requireState([original.sessionId,original.projectId,original.routeId].every(value=>typeof value==='string'&&ID.test(value))&&original.sessionId.length<=96,
    'The simulated proposal needs valid identifiers.');
  requireState(Array.isArray(blockedParcelIds)&&blockedParcelIds.every(id=>typeof id==='string'&&ID.test(id)),
    'Refused parcels must be valid identifiers.');
  const blocked=new Set(blockedParcelIds);
  requireState(role&&original.userRole&&role.parcelId===original.userRole.parcelId&&role.ownerId===original.userRole.ownerId&&
    blocked.has(role.parcelId)&&!route.parcelIds.includes(role.parcelId),
    'The refused original participant must remain off the new route.');
  requireState(Array.isArray(original.parcels)&&original.parcels.length>0&&Array.isArray(original.owners)&&Array.isArray(handoff.parcelAnalysis)&&
    sameIds(route.parcelIds,original.parcels.map(parcel=>parcel.parcelId))&&
    sameIds(route.parcelIds,handoff.parcelAnalysis.map(parcel=>parcel.parcelId))&&
    sameIds(route.parcelIds,handoff.snapshot.parcels.map(parcel=>parcel.id)),
    'Every final-route parcel must have matching proposal and impact data.');
  requireState(original.owners.some(owner=>owner.ownerId===role.ownerId)&&
    new Set(original.owners.map(owner=>owner.ownerId)).size===original.owners.length&&
    new Set(original.owners.map(owner=>owner.banking?.paymentRecipientRef)).size===original.owners.length,
    'The original owner and distinct mock banking destinations must be preserved.');
  for(const owner of original.owners){
    requireState(owner.synthetic===true&&owner.banking?.ownerId===owner.ownerId&&owner.banking.mode==='simulated'&&
      /^mock-[A-Za-z0-9._:-]+$/.test(owner.banking.paymentRecipientRef)&&/^\*{4}\d{4}$/.test(owner.banking.accountDisplay)&&
      owner.banking.accountHolderAlias===owner.alias&&owner.contact?.registration!=='registered'&&owner.contact?.callConsent===false,
      'Only fictional owners and their associated simulated banking profiles are supported.');
  }
  const ownerHandoff=copy(original),negotiations=[];
  for(let index=0;index<ownerHandoff.parcels.length;index++){
    const parcel=ownerHandoff.parcels[index],row=handoff.parcelAnalysis.find(item=>item.parcelId===parcel.parcelId);
    const snapshotParcel=handoff.snapshot.parcels.find(item=>item.id===parcel.parcelId);
    const owner=ownerHandoff.owners.find(item=>item.ownerId===parcel.ownerId);
    requireState(owner&&parcel.ownerId!==role.ownerId&&!blocked.has(parcel.parcelId)&&row.ownerId===parcel.ownerId&&
      snapshotParcel.ownerId===parcel.ownerId&&snapshotParcel.projectId===original.projectId&&
      ![parcel.terms?.accessConsent,row.accessConsent,snapshotParcel.accessConsent].includes('refused')&&
      ![parcel.terms?.outcome,row.negotiationStatus,snapshotParcel.negotiationStatus].includes('refused'),
      'Refused parcels and the original participant cannot receive simulated acceptance.');
    requireState(row.recommendationStatus==='estimated'&&row.corridorOnly===false&&
      cents(row.recommendedOfferCents)&&row.recommendedOfferCents===row.upfrontCents&&
      row.recommendedOfferCents===parcel.terms.compensationCents&&version(parcel.terms.termsVersion)&&
      row.withinOfferCap===true&&row.offerCapCents===negotiationLimitCents(row.recommendedOfferCents)&&
      parcel.offerCapCents===row.offerCapCents&&snapshotParcel.offerCapCents===row.offerCapCents&&
      Object.entries(createOfferPolicy(row.recommendedOfferCents)).every(([key,value])=>parcel.offerPolicy?.[key]===value),
      'Every simulated owner needs a priced recommendation and its unchanged 120 percent cap.');
    requireState(row.monthlyRentEquivalentCents===parcel.terms.monthlyRentCents,
      'The simulated monthly offer must match the displayed proposal.');
    const monthlyRentCents=parcel.terms.monthlyRentCents;
    const comparisonRentTotalCents=rentFor(monthlyRentCents,original.rentHorizonMonths);
    // Opaque local evidence identifies a scripted action, not a real conversation.
    const actionId=`mock:${original.sessionId}:r${route.version}:${index+1}`,confirmationRef=`${actionId}:ok`;
    parcel.terms={termsVersion:parcel.terms.termsVersion,outcome:'accepted',accessConsent:'allowed',
      explicitConfirmation:true,confirmationRef,compensationCents:row.recommendedOfferCents,
      monthlyRentCents,comparisonRentTotalCents,monthlyRentIsApproximate:false};
    owner.contact={contactRef:owner.contact.contactRef,registration:'simulation',callConsent:false};
    negotiations.push({schemaVersion:1,sourceMode:'mock',evidenceRefs:[confirmationRef],id:actionId,
      projectId:original.projectId,parcelId:parcel.parcelId,routeVersion:route.version,termsVersion:parcel.terms.termsVersion,
      sessionId:`mock:${original.sessionId}:${index+1}`,outcome:'accepted',accessConsent:'allowed',
      upfrontCents:parcel.terms.compensationCents,depositCents:0,depositCreditPolicy:'credited_to_upfront',
      monthlyRentCents,termMonths:original.rentHorizonMonths,conditions:[],explicitConfirmation:true});
  }
  const totals={constructionCents:original.constructionCents,
    compensationCents:sum(ownerHandoff.parcels.map(parcel=>parcel.terms.compensationCents)),
    rentTotalCents:sum(ownerHandoff.parcels.map(parcel=>parcel.terms.comparisonRentTotalCents))};
  totals.totalCostCents=sum([totals.constructionCents,totals.compensationCents,totals.rentTotalCents]);
  requireState(totals.totalCostCents<=original.budgetCents,'Exact simulated terms exceed the current project budget.');
  ownerHandoff.routeStatus='ready_for_agreements';
  return {kind:'easygrid-simulated-agreement',schemaVersion:1,sourceMode:'mock',mapBinding:settlementBinding(handoff),
    ownerHandoff,negotiations,totals};
}
