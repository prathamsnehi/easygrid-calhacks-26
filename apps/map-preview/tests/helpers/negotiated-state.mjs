import {applyNegotiationCommand} from '../../../../packages/contracts/src/negotiation.ts';
import {createOwnerHandoffCurrent} from '../../../../packages/contracts/src/owner-handoff-fixtures.ts';

/** Pure synthetic host fixture for tests or an explicitly labeled QA host. */
// The host imports these synthetic map IDs as canonical IDs before reducing a call.
// All agreement evidence below is produced by the shared negotiation reducer.
export function createNegotiatedStateFixture({ownerHandoff,mapBinding,localParcelId,amountCents,response = 'agree',
  attemptId = 'test-negotiated-attempt',eventId = 'test-negotiated-approved-event',approvedAt = '2026-10-25T12:00:00Z'}) {
  const packet = structuredClone(ownerHandoff);
  packet.referenceBinding = 'canonical';
  const current = createOwnerHandoffCurrent(packet);
  current.offerPolicies = Object.fromEntries(packet.parcels.map(p => [p.parcelId,{
    policyId:p.offerPolicy.policyId,basis:p.offerPolicy.basis,
    recommendedOfferCents:p.offerPolicy.recommendedOfferCents,offerCapCents:p.offerCapCents,
  }]));
  let state = {active:true,liveCallLocked:false,workflow:'negotiating',handoff:packet,current,attempts:{},receipts:{}};
  const parcelId = localParcelId ?? packet.userRole?.parcelId, original = packet.parcels.find(p => p.parcelId === parcelId);
  if (!original) throw new Error('The synthetic negotiation fixture needs a current participant parcel.');
  const agreedCents = amountCents ?? original.offerPolicy.recommendedOfferCents + Math.floor(original.offerPolicy.recommendedOfferCents / 10);
  let sequence = 0;
  const run = (command,turns = []) => {
    const termsVersion = state.attempts[attemptId]?.offers.at(-1)?.termsVersion ?? state.current.termsVersions[parcelId];
    state = applyNegotiationCommand(state,{attemptId,requestId:`test-command-${++sequence}`,
      routeVersion:packet.routeVersion,termsVersion,...command},turns).state;
  };
  run({kind:'prepare',parcelId,mode:'simulated'});
  run({kind:'counteroffer',requestedCents:agreedCents});
  const monthlyRentCents = original.terms.monthlyRentCents;
  const turns = [
    {id:'test-offer-turn',role:'agent',text:`We can offer $${agreedCents / 100} plus $${monthlyRentCents / 100} per month. Does that work for you?`,startMs:0,endMs:4000},
    {id:'test-owner-turn',role:'owner',text:response === 'conditions' ? 'Yes, but move the tower.' : 'Yes, that works.',startMs:4500,endMs:5500},
  ];
  run({kind:'response',response,turnId:'test-owner-turn'},turns);
  if (response === 'agree') run({kind:'finalize',candidate:{reason:'AGREED',offerTurnId:'test-offer-turn',ownerTurnId:'test-owner-turn',
    compensationCents:agreedCents,monthlyRentCents}},turns);
  const trusted = {mapBinding:structuredClone(mapBinding),localParcelId:parcelId,attemptId,eventId,
    revision:state.handoff.revision,approvedAt,state};
  const negotiationRef = {attemptId,eventId,revision:trusted.revision};
  return {trusted,negotiationRef,agreedCents,originalCents:original.terms.compensationCents};
}
