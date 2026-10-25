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

/** One dial for the registered participant. The phone number stays in `contact`. */
export const callAttempt = table(
  { name: 'call_attempt', indexes: [{ accessor: 'bySession', algorithm: 'btree', columns: ['sessionId'] }] },
  {
    attemptId: t.string().primaryKey(),
    sessionId: t.string(),
    parcelId: t.string(),
    routeVersion: t.u32(),
    providerCallId: t.string(),
    lifecycle: t.string(),
    mode: t.string(),
    phase: t.string(),
    openingCents: t.u32(),
    finalCents: t.u32(),
    monthlyRentCents: t.u32(),
    revision: t.u32(),
    checks: t.u32(),
    dialClaimed: t.bool(),
    reviewClaimed: t.bool(),
    outcome: t.string(),
    disposition: t.string(),
    reason: t.string(),
    explanation: t.string(),
    nextAction: t.string(),
    agreedCents: t.u32(),
  },
);

/** Provider transcript. Private, and never copied into the public summary. */
export const callTurn = table(
  { name: 'call_turn', indexes: [{ accessor: 'byAttempt', algorithm: 'btree', columns: ['attemptId'] }] },
  {
    id: t.string().primaryKey(),
    attemptId: t.string(),
    role: t.string(),
    text: t.string(),
    startMs: t.u32(),
    endMs: t.u32(),
    ordinal: t.u32(),
  },
);

/** Reused negotiation agent. This is not `CARTESIA_AGENT_ID`. */
export const voiceAgent = table(
  { name: 'voice_agent' },
  {
    id: t.string().primaryKey(),
    agentId: t.string(),
  },
);

/** Wakes `check_call` after the dialing procedure returns. */
export const callCheck = table(
  { name: 'call_check' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    attemptId: t.string(),
  },
);

/** Redacted result the map can read. No phone number and no transcript text. */
export const negotiationSummary = table(
  {
    name: 'negotiation_summary',
    public: true,
    indexes: [{ accessor: 'bySession', algorithm: 'btree', columns: ['sessionId'] }],
  },
  {
    attemptId: t.string().primaryKey(),
    sessionId: t.string(),
    parcelId: t.string(),
    mode: t.string(),
    phase: t.string(),
    lifecycle: t.string(),
    revision: t.u32(),
    outcome: t.string(),
    disposition: t.string(),
    reason: t.string(),
    explanation: t.string(),
    nextAction: t.string(),
    openingCents: t.u32(),
    finalCents: t.u32(),
    monthlyRentCents: t.u32(),
    agreedCents: t.u32(),
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
  callAttempt,
  callTurn,
  voiceAgent,
  callCheck,
  negotiationSummary,
}, {
  env: {
    CARTESIA_API_KEY: t.string(),
    CARTESIA_VOICE_ID: t.string(),
    CARTESIA_MODEL_ID: t.string(),
    CARTESIA_FROM_NUMBER_ID: t.string(),
    CARTESIA_FALLBACK_TO_NUMBER: t.string().optional(),
    CARTESIA_NEGOTIATION_AGENT_ID: t.string().optional(),
    ANTHROPIC_API_KEY: t.string(),
    ANTHROPIC_MODEL: t.string().optional(),
  },
});
