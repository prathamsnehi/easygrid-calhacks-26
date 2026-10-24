import { z } from 'zod';

export const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const Text = z.string().min(1).max(2000);
export const Cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const Revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const Version = Revision.min(1);
export const Timestamp = z.iso.datetime();
export const DateOnly = z.iso.date();
export const SourceMode = z.enum(['fixture', 'live', 'sandbox', 'mock']);
export const AccessConsent = z.enum(['unknown', 'allowed', 'refused']);
export const NegotiationStatus = z.enum(['pending', 'accepted', 'refused', 'counteroffer', 'review_required']);
export const EvidenceRefs = z.array(Text).max(100);
export const UniqueIds = z.array(Id).max(1000).refine(v => new Set(v).size === v.length, 'IDs must be unique');
export const Position = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
export const Point = z.strictObject({ type: z.literal('Point'), coordinates: Position });
export const LineString = z.strictObject({ type: z.literal('LineString'), coordinates: z.array(Position).min(2) });
const Ring = z.array(Position).min(4).refine(v => {
  const a = v[0]!, b = v[v.length - 1]!;
  return a[0] === b[0] && a[1] === b[1];
}, 'Polygon rings must be closed');
export const Polygon = z.strictObject({ type: z.literal('Polygon'), coordinates: z.array(Ring).min(1) });
export const Metadata = { schemaVersion: z.literal(1), sourceMode: SourceMode, evidenceRefs: EvidenceRefs };
export const Terms = {
  upfrontCents: Cents, depositCents: Cents,
  depositCreditPolicy: z.enum(['credited_to_upfront', 'separate_charge']),
  monthlyRentCents: Cents, termMonths: z.number().int().min(1).max(1200),
};
export const Project = z.strictObject({
  ...Metadata, id: Id, revision: Revision, endpointA: Point, endpointB: Point,
  budgetCents: Cents, rentHorizonMonths: z.number().int().min(1).max(1200),
  selectedRouteId: Id.nullable(), approvedRouteVersion: Version.nullable(),
  status: z.enum(['draft', 'evaluating', 'negotiating', 'review_required', 'approved', 'demo_settled']),
});
export const Owner = z.strictObject({ ...Metadata, id: Id, alias: Text, synthetic: z.boolean() });
export const Parcel = z.strictObject({
  ...Metadata, id: Id, projectId: Id, geometry: Polygon, ownerId: Id, ownerAlias: Text,
  synthetic: z.boolean(), landUse: Text, areaSqM: z.number().positive().finite(),
  offerCapCents: Cents, accessConsent: AccessConsent, negotiationStatus: NegotiationStatus,
});
export const RegulatoryCheck = z.strictObject({
  ...Metadata, id: Id, jurisdiction: Text, ruleCitation: Text, ruleVersion: Text,
  checkedAt: Timestamp, outcome: z.enum(['pass', 'fail', 'unknown']),
  missingEvidence: z.array(Text), preliminary: z.literal(true),
});
export const RouteCandidate = z.strictObject({
  ...Metadata, id: Id, projectId: Id, version: Version, geometry: LineString,
  parcelIds: UniqueIds.min(1), lengthMeters: z.number().positive().finite(),
  constructionCents: Cents, upfrontCompensationCents: Cents, recurringRentTotalCents: Cents,
  separateDepositTotalCents: Cents, totalCostCents: Cents,
  eligible: z.boolean(), readyToApprove: z.boolean(), reasons: z.array(Text),
  regulatoryChecks: z.array(RegulatoryCheck),
});
export const NegotiationResult = z.strictObject({
  ...Metadata, ...Terms, id: Id, projectId: Id, parcelId: Id, routeVersion: Version,
  termsVersion: Version, sessionId: Id, outcome: NegotiationStatus, accessConsent: AccessConsent,
  conditions: z.array(Text), exclusionGeometry: Polygon.optional(),
  explicitConfirmation: z.boolean(), confidence: z.number().min(0).max(1).optional(),
});
export const Easement = z.strictObject({
  ...Metadata, ...Terms, id: Id, contractVersion: Version, projectId: Id, parcelId: Id,
  routeId: Id, routeVersion: Version, termsVersion: Version, templateVersion: Id,
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  effectiveStartDate: DateOnly, effectiveEndDate: DateOnly,
  status: z.enum(['draft', 'awaiting_demo_signature', 'demo_signed', 'superseded']),
  signatureMode: z.enum(['simulated', 'provider_test']), signedAt: Timestamp.optional(), artifactRef: Text,
});
export const TermsVersions = z.record(Id, Version);
export const Approval = z.strictObject({
  ...Metadata, id: Id, projectId: Id, routeId: Id, routeVersion: Version,
  contractIds: UniqueIds.min(1), termsVersions: TermsVersions, contractVersions: TermsVersions,
  approvedBy: Id, approvedAt: Timestamp, valid: z.boolean(),
});
export const Payment = z.strictObject({
  ...Metadata, sourceMode: z.enum(['sandbox', 'mock']), id: Id, contractId: Id,
  contractVersion: Version, approvalId: Id, kind: z.enum(['deposit', 'rent']),
  installmentPeriod: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  expectedCents: Cents, actualCents: Cents.optional(), currency: z.literal('USD'),
  status: z.enum(['pending', 'settled', 'failed', 'unknown']), providerReference: Id.optional(), idempotencyKey: Id,
});
export const ReconciliationEntry = z.strictObject({
  ...Metadata, id: Id, contractId: Id, paymentId: Id.optional(),
  installmentPeriod: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  expectedCents: Cents, observedCents: Cents.optional(),
  result: z.enum(['matched', 'missing', 'amount_mismatch', 'duplicate', 'pending']),
  checkedAt: Timestamp,
});
export const AuditEvent = z.strictObject({
  ...Metadata, eventId: Id, projectId: Id, revision: Revision,
  type: z.enum(['project.created', 'routes.evaluated', 'call.started', 'negotiation.recorded',
    'routes.replanned', 'easement.created', 'easement.demo_signed', 'approval.created',
    'approval.invalidated', 'payment.updated', 'reconciliation.completed', 'demo.reset']),
  occurredAt: Timestamp, actor: Id, payload: z.record(z.string(), z.json()),
});
export const CallSession = z.strictObject({
  ...Metadata, sessionId: Id, projectId: Id, parcelId: Id, routeVersion: Version,
  status: z.enum(['creating', 'dialing', 'in_progress', 'completed', 'failed', 'unknown']),
  events: z.array(z.strictObject({ eventId: Id, occurredAt: Timestamp, type: Id, summary: Text })).max(100),
});
export const Snapshot = z.strictObject({
  project: Project, owners: z.array(Owner), parcels: z.array(Parcel), routes: z.array(RouteCandidate),
  negotiations: z.array(NegotiationResult), easements: z.array(Easement), approvals: z.array(Approval),
  payments: z.array(Payment), reconciliations: z.array(ReconciliationEntry), events: z.array(AuditEvent).max(100),
});

export const entities = { Project, Owner, Parcel, RouteCandidate, RegulatoryCheck, NegotiationResult,
  Easement, Approval, Payment, ReconciliationEntry, AuditEvent, CallSession, Snapshot } as const;
export type Project = z.infer<typeof Project>;
export type Parcel = z.infer<typeof Parcel>;
export type RouteCandidate = z.infer<typeof RouteCandidate>;
export type NegotiationResult = z.infer<typeof NegotiationResult>;
export type Easement = z.infer<typeof Easement>;
export type Approval = z.infer<typeof Approval>;
export type Payment = z.infer<typeof Payment>;
export type Snapshot = z.infer<typeof Snapshot>;
