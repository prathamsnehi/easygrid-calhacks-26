import {createHash} from 'node:crypto';
import {OwnerHandoff} from '../../../packages/contracts/src/owner-handoff.ts';
import {permittedNegotiationMaximum} from '../../../packages/contracts/src/negotiation.ts';
import {settlementBinding} from '../src/settlement-controller.js';
import {matchesContractBinding, voiceConditionAccessTerms} from '../src/contract-handoff.js';
import {localPointToGeoJSON} from '../src/handoff.js';

const copy = value => JSON.parse(JSON.stringify(value));
const check = (value,message) => {if (!value) throw new Error(message);};
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value);
const cents = value => Number.isSafeInteger(value) && value >= 0;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const samePolicy = (a,b) => a && b && ['policyId','basis','recommendedOfferCents','multiplierNumerator','multiplierDenominator','rounding'].every(key => a[key] === b[key]);
const sameOwner = (a,b) => a && b && a.synthetic === true && b.synthetic === true && a.ownerId === b.ownerId && a.alias === b.alias &&
  ['ownerId','paymentRecipientRef','mode','accountHolderAlias','bankDisplay','accountDisplay'].every(key => a.banking?.[key] === b.banking?.[key]);
const condition = value => value && Object.keys(value).length === 2 && value.target === 'edge' && ['north','south','east','west'].includes(value.direction);
const sameCondition = (a,b) => condition(a) && condition(b) && a.direction === b.direction && a.target === b.target;
function packet(value) {try {return OwnerHandoff.parse(value);} catch {throw new Error('The saved voice map does not have valid fictional owner terms.');}}

/** Both values derive from the immutable terminal database row, never a browser reference or wall clock. */
export function voiceCommitReference(attempt) {
  check(id(attempt?.id) && Number.isSafeInteger(attempt.revision) && attempt.revision > 0,'A saved voice attempt and revision are required.');
  const eventId = `voice-${attempt.id}-${attempt.revision}`;
  check(id(eventId),'The saved voice event identifier is invalid.');
  return {attemptId:attempt.id,eventId,revision:attempt.revision};
}
export function voiceCommitApprovedAt(attempt) {
  check(typeof attempt?.updatedAtMicros === 'string' && /^\d{1,20}$/.test(attempt.updatedAtMicros),'The saved voice commit needs its database timestamp.');
  const millis = BigInt(attempt.updatedAtMicros) / 1000n;
  check(millis > 0n && millis <= 8_640_000_000_000_000n,'The saved voice commit timestamp is invalid.');
  return new Date(Number(millis)).toISOString();
}

/** Keep the first call's fixed policies while retaining recomputed geometry and construction estimates. */
export function applyOriginalVoicePolicies(finalHandoff, originalHandoff) {
  const original = packet(originalHandoff?.ownerHandoff), result = copy(finalHandoff), current = packet(result?.ownerHandoff);
  check(current.sessionId === original.sessionId && current.projectId === original.projectId && same(current.userRole,original.userRole),
    'A relocated voice proposal must preserve its original session and participant.');
  check(current.budgetCents === original.budgetCents && current.rentHorizonMonths === original.rentHorizonMonths,'The original project budget and policy horizon cannot change.');
  for (const parcel of result.ownerHandoff.parcels) {
    const prior = original.parcels.find(item => item.parcelId === parcel.parcelId);
    if (!prior) continue;
    check(parcel.ownerId === prior.ownerId && sameOwner(current.owners.find(o => o.ownerId === parcel.ownerId),original.owners.find(o => o.ownerId === prior.ownerId)),
      'A relocated proposal cannot replace an original fictional owner or recipient.');
    parcel.offerPolicy=copy(prior.offerPolicy);parcel.offerCapCents=prior.offerCapCents;parcel.terms=copy(prior.terms);
    const snapshotParcel=result.snapshot?.parcels?.find(item => item.id === parcel.parcelId);
    if (snapshotParcel) snapshotParcel.offerCapCents=prior.offerCapCents;
    const row=result.parcelAnalysis?.find(item => item.parcelId === parcel.parcelId);
    if (row) Object.assign(row,{offerPolicy:copy(prior.offerPolicy),recommendedOfferCents:prior.offerPolicy.recommendedOfferCents,
      offerCapCents:prior.offerCapCents,monthlyRentEquivalentCents:prior.terms.monthlyRentCents,monthlyRentIsApproximate:prior.terms.monthlyRentIsApproximate});
  }
  const selected=original.parcels.find(item => item.parcelId === original.userRole?.parcelId), proposed=result.callPreparation?.proposedTerms;
  if (selected && proposed) Object.assign(proposed,{upfrontCents:selected.terms.compensationCents,recommendedOfferCents:selected.offerPolicy.recommendedOfferCents,
    offerCapCents:selected.offerCapCents,offerPolicy:copy(selected.offerPolicy),monthlyRentEquivalentCents:selected.terms.monthlyRentCents,
    monthlyRentIsApproximate:selected.terms.monthlyRentIsApproximate,rentTotalCents:selected.terms.comparisonRentTotalCents});
  return result;
}

/** Server-only bridge for a committed provider result. This never manufactures legacy CAL-34 approval. */
export function agreementFromSavedVoice(trusted,handoff,reference) {
  const a=trusted?.attempt, ref=voiceCommitReference(a), approvedAt=voiceCommitApprovedAt(a);
  check(trusted.kind === 'easygrid-voice-commit' && reference && Object.keys(reference).length === 3 &&
    ['attemptId','eventId','revision'].every(key => reference[key] === ref[key]),'The saved voice reference is stale or belongs to another call.');
  check(a.status === 'accepted' && a.outcome?.status === 'accepted' && id(a.providerCallId) && a.paymentSchedule === 'full-after-signatures',
    'A completed provider call with committed acceptance is required.');
  let original;
  try {check(typeof a.canonicalJson === 'string' && a.canonicalJson.length <= 2_000_000,'invalid');original=JSON.parse(a.canonicalJson).handoff;} catch {throw new Error('The original saved voice map is unavailable.');}
  const baseline=packet(handoff?.ownerHandoff), initial=packet(original?.ownerHandoff), binding=settlementBinding(handoff), initialBinding=settlementBinding(original);
  check(matchesContractBinding(a.mapBinding,initialBinding) && matchesContractBinding(a.outcome.originalMapBinding,initialBinding) &&
    a.sessionId === initial.sessionId && baseline.sessionId === initial.sessionId && baseline.projectId === initial.projectId &&
    handoff.snapshot?.routes?.[0]?.eligible === true && baseline.simulationChecksPassed === true,'The accepted voice result does not match its original and current map.');
  const selected=baseline.parcels.find(p => p.parcelId === a.parcelId), prior=initial.parcels.find(p => p.parcelId === a.parcelId);
  check(prior && selected && same(initial.userRole,baseline.userRole) && prior.parcelId === initial.userRole?.parcelId &&
    prior.ownerId === initial.userRole.ownerId && selected.ownerId === prior.ownerId && a.outcome.parcelId === prior.parcelId &&
    (a.ownerId === undefined || a.ownerId === prior.ownerId),'The accepted voice result must preserve the original participant parcel.');
  check(initial.budgetCents === baseline.budgetCents && initial.rentHorizonMonths === baseline.rentHorizonMonths,'The original project policy changed.');
  check(initial.parcels.length === baseline.parcels.length && baseline.parcels.every(p => initial.parcels.some(old => old.parcelId === p.parcelId)),
    'A same-parcel voice relocation cannot add or remove affected landowners.');
  for (const p of baseline.parcels) {
    check(p.terms.outcome === 'pending' && p.terms.explicitConfirmation === false && p.terms.confirmationRef === null && p.terms.accessConsent !== 'refused',
      'Voice contract preparation cannot invent acceptance for another owner.');
    const old=initial.parcels.find(item => item.parcelId === p.parcelId);
    if (!old) continue;
    check(p.ownerId === old.ownerId && sameOwner(baseline.owners.find(o => o.ownerId === p.ownerId),initial.owners.find(o => o.ownerId === old.ownerId)) &&
      samePolicy(p.offerPolicy,old.offerPolicy) && p.offerCapCents === old.offerCapCents &&
      p.terms.compensationCents === old.terms.compensationCents && p.terms.monthlyRentCents === old.terms.monthlyRentCents &&
      p.terms.termsVersion === old.terms.termsVersion,'The original owner, recipient and fixed compensation policy must survive relocation.');
  }
  const c=a.candidate, amount=a.outcome.acceptedCompensationCents;
  check(c && ['accepted','conditional'].includes(c.decision) && cents(amount) && amount === c.acceptedCompensationCents &&
    cents(a.currentOfferCents) && amount === a.currentOfferCents && cents(a.maxOfferCents) &&
    a.maxOfferCents >= a.offerCents && a.maxOfferCents <= a.capCents && amount <= a.maxOfferCents &&
    a.offerCents === prior.offerPolicy?.recommendedOfferCents && a.capCents === prior.offerCapCents &&
    amount >= a.offerCents && amount <= a.capCents && amount <= permittedNegotiationMaximum(initial,prior.parcelId) &&
    amount <= permittedNegotiationMaximum(baseline,prior.parcelId),'The voice compensation must match the saved acceptance and original fixed limits.');
  const turns=(a.evidence ?? []).findLast(item => Array.isArray(item?.turns))?.turns ?? [];
  const ownerTurns=turns.filter(t => t.id === c.evidenceTurnId), offerTurns=turns.filter(t => t.id === c.offerTurnId);
  check(id(c.evidenceTurnId) && typeof c.evidenceQuote === 'string' && c.evidenceQuote.trim() && ownerTurns.length === 1 &&
    ownerTurns.every(t => t.role === 'owner' && t.text === c.evidenceQuote) && id(c.offerTurnId) && typeof c.offerQuote === 'string' && c.offerQuote.trim() &&
    offerTurns.length === 1 && offerTurns.every(t => t.role === 'agent' && t.text === c.offerQuote) &&
    turns.indexOf(offerTurns[0]) < turns.indexOf(ownerTurns[0]),
    'The accepted voice terms require matching saved provider offer and owner evidence.');
  const finalBinding=a.outcome.resultingMapBinding ?? a.mapBinding;
  check(matchesContractBinding(finalBinding,binding),'The accepted voice terms refer to a different current route.');
  let approvedAccessTerms;
  if (c.decision === 'conditional') {
    const proof=a.outcome.relocationVerification, route=trusted.resultingRoute;
    check(condition(c.condition) && proof?.verified === true && sameCondition(c.condition,proof.condition) &&
      proof.parcelId === prior.parcelId && proof.acceptedCompensationCents === amount &&
      matchesContractBinding(proof.originalMapBinding,initialBinding) && matchesContractBinding(proof.resultingMapBinding,binding) &&
      binding.routeVersion > initialBinding.routeVersion && typeof proof.geometryHash === 'string' && /^[a-f0-9]{64}$/.test(proof.geometryHash) &&
      route && createHash('sha256').update(JSON.stringify(route)).digest('hex') === proof.geometryHash && route.id === binding.routeId &&
      Array.isArray(route.nodes) && same(route.nodes.map(p => localPointToGeoJSON(p.x,p.z).coordinates),handoff.snapshot.routes[0].geometry.coordinates),
      'Conditional acceptance requires verified same-parcel geometry for the exact saved condition and amount.');
    approvedAccessTerms={[prior.parcelId]:voiceConditionAccessTerms(c.condition.direction)};
  } else check(c.condition === null && !a.outcome.relocationVerification && matchesContractBinding(binding,initialBinding),
    'An unconditional voice acceptance cannot change the approved route.');
  check(a.outcome.hasUnresolvedConditions !== true && c.hasUnresolvedConditions !== true,'Unresolved voice conditions cannot authorize a contract.');
  const redacted=copy(handoff.ownerHandoff), parcel=redacted.parcels.find(p => p.parcelId === prior.parcelId);
  redacted.revision=ref.revision;
  // The live call offers only one compensation payment. Original monthly figures
  // remain conservative budget policy above; they never become unspoken rent consent.
  Object.assign(parcel.terms,{outcome:'accepted',accessConsent:'allowed',explicitConfirmation:true,confirmationRef:c.evidenceTurnId,
    compensationCents:amount,termsVersion:prior.terms.termsVersion+1,monthlyRentCents:0,monthlyRentIsApproximate:false,comparisonRentTotalCents:0});
  return {kind:'easygrid-negotiated-agreement',schemaVersion:1,sourceMode:'mock',contractTermsVersion:2,
    approvalScope:{kind:'single-owner',parcelId:prior.parcelId},mapBinding:binding,ownerHandoff:redacted,
    negotiationId:ref.attemptId,negotiationVersion:ref.revision+1,approvedAt,...(approvedAccessTerms ? {approvedAccessTerms} : {})};
}
