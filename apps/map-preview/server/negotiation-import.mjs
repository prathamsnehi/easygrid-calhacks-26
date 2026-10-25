import { OwnerHandoff } from '../../../packages/contracts/src/owner-handoff.ts';
import { reconstructMapProposal } from './map-contracts.mjs';
import { settlementBinding } from '../src/settlement-controller.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BINDING_KEYS = ['sessionId', 'routeId', 'routeVersion', 'proposalKey'];
const sameBinding = (left, right) => Boolean(left && right) && BINDING_KEYS.every(key => left[key] === right[key]);
const requireState = (condition, message) => { if (!condition) throw new Error(message); };

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Build the canonical import packet from a reconstructed fixture. The private
 * registration replaces only the consenting participant's contact reference. */
export function canonicalNegotiationPacket(handoff, registration, session) {
  requireState(handoff?.ownerHandoff?.referenceBinding === 'local-fixture', 'Reconstruction must start from the local fixture handoff.');
  requireState(IDENTIFIER.test(session?.sessionId ?? '') && Number.isSafeInteger(session.revision) && session.revision >= 0
    && Number.isSafeInteger(session.budgetCents) && session.budgetCents >= 0, 'A current authoritative session is required.');
  requireState(session.budgetCents === handoff.ownerHandoff.budgetCents, 'The registered session budget does not match the reconstructed map.');
  requireState(registration?.callConsent === true && IDENTIFIER.test(registration.contactRef ?? ''),
    'The consenting participant must be resolved from the private registration.');
  const packet = copy(handoff.ownerHandoff);
  packet.referenceBinding = 'canonical';
  packet.sessionId = session.sessionId;
  packet.revision = session.revision;
  packet.routeStatus = 'selected_for_negotiation';
  const role = packet.userRole;
  requireState(role && registration.ownerId === role.ownerId, 'Private registration does not match the reconstructed participant.');
  for (const owner of packet.owners) {
    if (owner.ownerId === role.ownerId) {
      owner.contact = { contactRef: registration.contactRef, registration: 'registered', callConsent: true };
    } else {
      owner.contact = { contactRef: owner.contact.contactRef, registration: 'simulation', callConsent: false };
    }
  }
  for (const parcel of packet.parcels) {
    requireState(parcel.offerPolicy && parcel.terms.compensationCents === parcel.offerPolicy.recommendedOfferCents,
      'Import must keep the reconstructed recommendation.');
    parcel.terms = { ...parcel.terms, outcome: 'pending', accessConsent: 'unknown', explicitConfirmation: false, confirmationRef: null };
  }
  return OwnerHandoff.parse(packet);
}

/** Reconstruct the map on the server and bind that packet. Browser handoff JSON is not an input. */
export async function importReconstructedNegotiation({ context, registration, session, requestKey, client }) {
  requireState(context && typeof context === 'object' && !Object.hasOwn(context, 'participant') && !Object.hasOwn(context, 'phone')
    && !Object.hasOwn(context, 'ownerHandoff') && !Object.hasOwn(context, 'handoffJson'),
  'The browser packet is not the authority for this import.');
  requireState(IDENTIFIER.test(requestKey ?? ''), 'A stable import request id is required.');
  requireState(client && typeof client.callReducer === 'function', 'A commit-aware negotiation client is required.');
  const handoff = reconstructMapProposal(context);
  const packet = canonicalNegotiationPacket(handoff, registration, session);
  const mapBinding = settlementBinding(handoff);
  requireState(sameBinding(mapBinding, context.mapBinding), 'The public proposal binding does not match the reconstructed map.');
  const serialized = JSON.stringify({ packet, mapBinding });
  requireState(!/"\+[1-9]\d{7,14}"/.test(serialized), 'The import packet must not carry a phone number.');
  await client.callReducer('bind_negotiation', {
    sessionId: session.sessionId,
    expectedRevision: session.revision,
    requestKey,
    handoffJson: JSON.stringify(packet),
    mapBindingJson: JSON.stringify(mapBinding),
  });
  return { canonicalSessionId: session.sessionId, mapBinding, packet };
}

/** Deliver saved rows before reporting the subscription ready. */
export function createSavedNegotiationResultSource({ readResults, mapBinding }) {
  requireState(typeof readResults === 'function' && mapBinding && BINDING_KEYS.every(key => mapBinding[key] !== undefined),
    'A saved-result subscription needs the imported map binding.');
  return ({ mapBinding: pageBinding, signal, onUpdate, onReady, onUnavailable }) => {
    if (signal?.aborted) return () => {};
    if (!sameBinding(pageBinding, mapBinding)) {
      onUnavailable();
      return () => {};
    }
    let stopped = false;
    const stop = () => { stopped = true; };
    signal?.addEventListener?.('abort', stop);
    Promise.resolve().then(async () => {
      try {
        const rows = await readResults();
        if (stopped || signal?.aborted) return;
        const ordered = [...rows].sort((left, right) => left.revision - right.revision);
        for (const row of ordered) {
          const update = JSON.parse(row.updateJson);
          if (!sameBinding(update.mapBinding, mapBinding)) throw new Error('Saved result binding changed.');
          const delivery = onUpdate(update);
          if (delivery?.status === 'ignored') throw new Error('The saved result does not match the current map.');
        }
        if (!stopped && !signal?.aborted) onReady();
      } catch {
        if (!stopped && !signal?.aborted) onUnavailable();
      }
    });
    return stop;
  };
}

/** Public restoration record from an active saved binding. Contact fields are not copied. */
export function registeredDemoRestoreRecord(active) {
  requireState(active?.active === true && active.mapBinding, 'There is no active registered demo to restore.');
  let proposal;
  try { proposal = JSON.parse(active.mapBinding.proposalKey); }
  catch { throw new Error('The saved map binding is unreadable.'); }
  const userParcelId = proposal?.ownerHandoff?.userRole?.parcelId;
  requireState(typeof userParcelId === 'string' && IDENTIFIER.test(userParcelId), 'The saved map binding has no participant parcel.');
  return {
    sessionId: active.mapBinding.sessionId,
    routeId: active.mapBinding.routeId,
    routeVersion: active.mapBinding.routeVersion,
    userParcelId,
    mapBinding: active.mapBinding,
  };
}

/** Facility coordinates alone do not reattach a registered demo. */
export function assessRegisteredDemo({ facilities = null, active = null, recomputedBinding = null } = {}) {
  const facilitiesRestored = Boolean(facilities?.substation && facilities?.datacenter);
  if (!active?.active || !active.mapBinding) {
    return { restored: false, facilitiesRestored, reason: facilitiesRestored ? 'facilities-only' : 'empty' };
  }
  if (!sameBinding(recomputedBinding, active.mapBinding)) {
    return { restored: false, facilitiesRestored, reason: 'binding-mismatch' };
  }
  return { restored: true, facilitiesRestored, mapBinding: active.mapBinding };
}
