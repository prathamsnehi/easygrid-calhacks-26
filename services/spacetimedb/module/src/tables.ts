import { schema, table, t } from 'spacetimedb/server';

/** One demo session. The registered phone number lives in `contact`, not here. */
export const session = table(
  { name: 'session' },
  {
    sessionId: t.string().primaryKey(),
    operatorIdentity: t.string(),
    workerIdentity: t.string(),
    revision: t.u32(),
    status: t.string(),
    routeVersion: t.u32(),
    publishedRouteCount: t.u32(),
    liveParcelId: t.string(),
    projectBudgetCents: t.u32(),
    explanation: t.string(),
  },
);

/** Private participant phone for the one live landowner role. */
export const contact = table(
  { name: 'contact' },
  {
    sessionId: t.string().primaryKey(),
    phone: t.string(),
  },
);

/** Parcels that have already refused and cannot return on a later route. */
export const exclusion = table(
  { name: 'exclusion', indexes: [{ accessor: 'bySession', algorithm: 'btree', columns: ['sessionId'] }] },
  {
    id: t.string().primaryKey(),
    sessionId: t.string(),
    parcelId: t.string(),
  },
);

/** Tower parcels published with a route version. Corridor parcels are not stored. */
export const routeParcel = table(
  { name: 'route_parcel', indexes: [{ accessor: 'bySession', algorithm: 'btree', columns: ['sessionId'] }] },
  {
    id: t.string().primaryKey(),
    sessionId: t.string(),
    routeVersion: t.u32(),
    parcelId: t.string(),
    ownerAlias: t.string(),
    towerCount: t.u32(),
    lineLengthMillis: t.u32(),
    recommendedOfferCents: t.u32(),
    offerCapCents: t.u32(),
    monthlyRentCents: t.u32(),
    role: t.string(),
    outcome: t.string(),
    agreedCompensationCents: t.u32(),
    explanation: t.string(),
  },
);

/** Request-key receipt. A matching fingerprint is a replay. A different payload conflicts. */
export const receipt = table(
  { name: 'receipt', indexes: [{ accessor: 'bySession', algorithm: 'btree', columns: ['sessionId'] }] },
  {
    id: t.string().primaryKey(),
    sessionId: t.string(),
    requestKey: t.string(),
    fingerprint: t.string(),
    resultCode: t.string(),
    revision: t.u32(),
  },
);

/** One simulated contract-tranche obligation. The id is the business obligation, not the request key. */
export const obligation = table(
  { name: 'obligation', indexes: [{ accessor: 'bySession', algorithm: 'btree', columns: ['sessionId'] }] },
  {
    id: t.string().primaryKey(),
    sessionId: t.string(),
    parcelId: t.string(),
    stage: t.string(),
    amountCents: t.u32(),
    compensationCents: t.u32(),
    requestKey: t.string(),
  },
);

export const agreement = table(
  { name: 'agreement' },
  {
    sessionId: t.string().primaryKey(),
    routeVersion: t.u32(),
    revision: t.u32(),
  },
);

/** CAL-41 snapshots are private. Public clients only see authorized, redacted views. */
export const negotiationSession = table(
  { name: 'negotiation_session' },
  {
    sessionId: t.string().primaryKey(),
    importRequestId: t.string(),
    importFingerprint: t.string(),
    mapBindingJson: t.string(),
    stateJson: t.string(),
  },
);

export const negotiationResult = table(
  { name: 'negotiation_result', indexes: [{ accessor: 'bySession', algorithm: 'btree', columns: ['sessionId'] }] },
  {
    id: t.string().primaryKey(),
    sessionId: t.string(),
    attemptId: t.string(),
    revision: t.u32(),
    updateJson: t.string(),
  },
);

/** A review lease belongs to one durable claim, not a process-local lock. */
export const negotiationReview = table(
  { name: 'negotiation_review' },
  {
    id: t.string().primaryKey(),
    sessionId: t.string(),
    attemptId: t.string(),
    claimId: t.string(),
    workerIdentity: t.string(),
    leaseUntilMicros: t.u64(),
    completed: t.bool(),
  },
);

export const spacetimedb = schema({
  session,
  contact,
  exclusion,
  routeParcel,
  receipt,
  obligation,
  agreement,
  negotiationSession,
  negotiationResult,
  negotiationReview,
});
