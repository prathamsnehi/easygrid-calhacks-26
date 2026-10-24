import { z } from 'zod';
import { ContractError } from './api.ts';
import { OwnerHandoff } from './owner-handoff.ts';
import { validateNegotiation, validateTerms } from './policy.ts';
import { Id, Version, Snapshot, NegotiationResult } from './schemas.ts';

const MapProposal = z.object({
  schemaVersion: z.literal(2), kind: z.literal('easygrid-map-handoff'), sourceMode: z.literal('fixture'),
  sessionId: Id, routeVersion: Version, snapshot: Snapshot, ownerHandoff: OwnerHandoff,
  coordinateTransform: z.record(z.string(), z.json()), costModel: z.record(z.string(), z.json()),
});
const Binding = z.strictObject({
  projectId: Id, callSessionId: Id, parcelId: Id, routeVersion: Version,
  termsVersion: Version, localParcelId: Id,
});
export type MapNegotiationBinding = z.infer<typeof Binding>;

function requireBinding(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ContractError('STALE_VERSION', message);
}

/**
 * Project an already authenticated, server-bound outcome onto a displayed map proposal.
 * This helper does not authenticate callers, save state or establish approval. The host
 * must obtain `binding` and verification flags from its current authoritative call record,
 * compare the supplied map proposal with its import mapping, and send only sanitized opaque
 * evidence references. Never copy those values from model output or browser requests.
 *
 * Spatial verification means the host corroborated the complete requested spatial change,
 * resolved all condition text, and validated the polygon against the displayed map/parcel.
 * Polygon shape validation alone cannot establish those facts. Conditional acceptance
 * always needs a new current-route confirmation after planning.
 */
export function createMapNegotiationUpdate({ handoff, result, binding,
  confirmationVerified, spatialConditionsVerified = false }: {
  handoff: unknown; result: unknown; binding: MapNegotiationBinding;
  confirmationVerified: boolean; spatialConditionsVerified?: boolean;
}) {
  z.boolean().parse(confirmationVerified); z.boolean().parse(spatialConditionsVerified);
  const map = MapProposal.parse(handoff), canonical = Binding.parse(binding);
  const negotiation = NegotiationResult.parse(result), packet = map.ownerHandoff;
  const route = map.snapshot.routes.find(candidate => candidate.id === packet.routeId);
  requireBinding(map.sessionId === packet.sessionId && map.routeVersion === packet.routeVersion &&
    map.snapshot.project.id === packet.projectId && map.snapshot.project.selectedRouteId === packet.routeId &&
    route?.projectId === packet.projectId && route.version === packet.routeVersion,
  'The map packet does not describe one current session and route');
  requireBinding(negotiation.projectId === canonical.projectId && negotiation.sessionId === canonical.callSessionId &&
    negotiation.parcelId === canonical.parcelId && negotiation.routeVersion === canonical.routeVersion &&
    negotiation.termsVersion === canonical.termsVersion,
  'The outcome does not match the authoritative call and terms binding');
  const local = packet.parcels.find(parcel => parcel.parcelId === canonical.localParcelId);
  const parcel = map.snapshot.parcels.find(item => item.id === canonical.localParcelId);
  const owner = local && packet.owners.find(item => item.ownerId === local.ownerId);
  requireBinding(local && parcel && owner && route.parcelIds.includes(local.parcelId) &&
    parcel.projectId === packet.projectId && parcel.ownerId === local.ownerId &&
    parcel.offerCapCents === local.offerCapCents,
  'The imported parcel, owner and fixed offer cap do not match the displayed route');
  // Validate amounts for every outcome, including results that will be downgraded.
  const terms = {
    upfrontCents: negotiation.upfrontCents, depositCents: negotiation.depositCents,
    depositCreditPolicy: negotiation.depositCreditPolicy, monthlyRentCents: negotiation.monthlyRentCents,
    termMonths: negotiation.termMonths,
  };
  validateTerms(terms);
  const corroborated = confirmationVerified && negotiation.explicitConfirmation && negotiation.evidenceRefs.length > 0;
  const spatialVerified = !!negotiation.exclusionGeometry && corroborated && spatialConditionsVerified;
  const hasUnresolvedConditions = (negotiation.conditions.length > 0 || !!negotiation.exclusionGeometry) && !spatialVerified;
  let outcome = negotiation.outcome, accessConsent = negotiation.accessConsent;
  let explicitConfirmation = corroborated;
  if (outcome === 'refused') {
    if (!corroborated || accessConsent !== 'refused') {
      outcome = 'review_required'; accessConsent = 'unknown'; explicitConfirmation = false;
    }
  } else if (outcome === 'accepted') {
    if (!corroborated) {
      outcome = 'review_required'; accessConsent = 'unknown'; explicitConfirmation = false;
    } else {
      // A conditioned accepted claim still must obey the existing exact-money/cap policy.
      validateNegotiation(negotiation, local.offerCapCents);
      if (negotiation.conditions.length > 0 || negotiation.exclusionGeometry) {
        outcome = 'counteroffer'; accessConsent = 'unknown'; explicitConfirmation = false;
      }
    }
  } else {
    // Nonfinal outcomes cannot assert acceptance or a whole-parcel refusal.
    if (accessConsent === 'refused') outcome = 'review_required';
    accessConsent = 'unknown'; explicitConfirmation = false;
  }
  // Preserve the original public packet's property order: this is an exact map equality
  // key, not a signature. Zod's parsed object order need not equal the browser's order.
  const original = handoff as z.infer<typeof MapProposal>;
  return {
    schemaVersion: 1 as const, kind: 'easygrid-map-negotiation' as const, eventId: negotiation.id,
    mapBinding: {
      sessionId: map.sessionId, routeId: packet.routeId, routeVersion: map.routeVersion,
      proposalKey: JSON.stringify({ snapshot: original.snapshot, ownerHandoff: original.ownerHandoff,
        coordinateTransform: original.coordinateTransform, costModel: original.costModel }),
    },
    parcelId: local.parcelId, sourceMode: negotiation.sourceMode, outcome, accessConsent,
    explicitConfirmation, evidenceRefs: [...negotiation.evidenceRefs], termsVersion: negotiation.termsVersion,
    terms, hasUnresolvedConditions,
    ...(spatialVerified ? { exclusionGeometry: structuredClone(negotiation.exclusionGeometry!) } : {}),
  };
}
export type MapNegotiationUpdate = ReturnType<typeof createMapNegotiationUpdate>;
