import { DEMO_METERS_PER_TILE } from './cost-model.js';

const ORIGIN = 'https://maincloud.spacetimedb.com';
const DATABASE = 'easygrid-demo';
const TOKEN_KEY = 'easygrid-demo-client-token';
const CONFIRMED_REFUSAL_REASONS = ['PRICE_REJECTED', 'ACCESS_REFUSED', 'DO_NOT_CALL'];

export function buildDialArgs(handoff, participant, callSessionId = handoff?.sessionId) {
  const parcelId = handoff?.userRole?.parcelId;
  const row = handoff?.parcelAnalysis?.find(item => item.parcelId === parcelId);
  const sessionId = typeof callSessionId === 'string' && callSessionId ? callSessionId : handoff?.sessionId;
  if (!sessionId || sessionId.length > 128 || !row || !parcelId) throw new Error('Register the participant on a current route before calling.');
  if (!Number.isInteger(row.towerCount) || row.towerCount <= 0) throw new Error('This parcel has no tower to negotiate.');
  if (participant?.consent !== true) throw new Error('A live call requires the participant consent checkbox.');
  const phone = String(participant.phoneE164 || participant.phone || '');
  const packet = handoff.ownerHandoff?.parcels?.find(item => item.parcelId === parcelId);
  const monthlyRentCents = row.monthlyRentCents ?? row.monthlyRentEquivalentCents ?? packet?.terms?.monthlyRentCents;
  const line = Math.round(Number(row.lineLengthTiles) * DEMO_METERS_PER_TILE * 1000);
  return {
    sessionId,
    phone,
    consent: true,
    projectBudgetCents: handoff.ownerHandoff.budgetCents,
    requestKey: `dial-${sessionId}`.slice(0, 120),
    parcelId,
    ownerAlias: String(row.ownerAlias || 'Owner').slice(0, 128),
    towerCount: row.towerCount,
    lineLengthMillis: Math.max(0, Math.min(Number.isFinite(line) ? line : 0, 0xffffffff)),
    recommendedOfferCents: row.recommendedOfferCents,
    offerCapCents: row.offerCapCents,
    monthlyRentCents,
  };
}

function field(row, name) {
  if (!row || typeof row !== 'object') return undefined;
  if (name in row) return row[name];
  const target = name.toLowerCase().replaceAll('_', '');
  for (const key of Object.keys(row)) {
    if (key.toLowerCase().replaceAll('_', '') === target) return row[key];
  }
  return undefined;
}

function wholeCents(row, name) {
  const value = field(row, name);
  const cents = typeof value === 'bigint' ? Number(value) : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

export function projectNegotiationResult(row, mapBinding) {
  const attemptId = String(field(row, 'attemptId') ?? '');
  const phase = field(row, 'phase');
  const mode = field(row, 'mode');
  const revision = Number(field(row, 'revision'));
  const finished = phase === 'finished';
  const summary = finished ? {
    attemptId,
    mode,
    reason: field(row, 'reason'),
    disposition: field(row, 'disposition'),
    explanation: field(row, 'explanation'),
    nextAction: field(row, 'nextAction'),
    outcome: field(row, 'outcome'),
  } : null;
  // The public summary stores the saved amount, not a terms version. A priced
  // agreement has to carry that amount or the map treats the saved yes as missing.
  if (summary?.disposition === 'successful' && summary.reason === 'AGREED' && summary.outcome === 'accepted') {
    const agreed = wholeCents(row, 'agreedCents');
    const monthly = wholeCents(row, 'monthlyRentCents');
    const version = wholeCents(row, 'termsVersion');
    summary.accessConsent = 'allowed';
    summary.agreedCents = agreed;
    summary.offeredCents = agreed;
    summary.monthlyRentCents = monthly;
    summary.termsVersion = version ?? 1;
  }
  return {
    schemaVersion: 1,
    kind: 'easygrid-negotiation-result',
    eventId: `${attemptId}-r${revision}`,
    revision,
    saved: true,
    mapBinding,
    localParcelId: field(row, 'parcelId'),
    mode,
    phase,
    summary,
  };
}

function rowsFromSql(payload) {
  const statements = Array.isArray(payload) ? payload : [payload];
  const rows = [];
  for (const statement of statements) {
    if (!statement || statement.error) continue;
    const elements = statement.schema?.elements ?? [];
    for (const row of statement.rows ?? []) {
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        rows.push(row);
        continue;
      }
      const named = {};
      elements.forEach((element, index) => {
        const name = element?.name?.some ?? element?.name ?? `column${index}`;
        named[name] = row?.[index];
      });
      rows.push(named);
    }
  }
  return rows;
}

function escapeSql(value) {
  return String(value).replaceAll("'", "''");
}

export function createLiveCallHost({
  fetch: fetchImpl = globalThis.fetch,
  origin = ORIGIN,
  database = DATABASE,
  storage = globalThis.sessionStorage,
  lockLiveCall = () => {},
  onConfirmedRefusal = () => {},
  schedulePoll = (fn, ms) => setInterval(fn, ms),
  cancelPoll = id => clearInterval(id),
  installSource = () => {},
} = {}) {
  async function clientToken() {
    const saved = storage?.getItem(TOKEN_KEY);
    if (saved) return saved;
    const response = await fetchImpl(`${origin}/v1/identity`, { method: 'POST' });
    if (!response.ok) throw new Error('The call service could not start a session.');
    const header = response.headers?.get?.('spacetime-identity-token');
    const body = header ? null : await response.json();
    const token = header || body?.token;
    if (!token) throw new Error('The call service could not start a session.');
    storage?.setItem(TOKEN_KEY, token);
    return token;
  }

  async function summaries(token, sessionId) {
    const query = `SELECT * FROM negotiation_summary WHERE session_id = '${escapeSql(sessionId)}'`;
    const response = await fetchImpl(`${origin}/v1/database/${database}/sql`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: query,
    });
    if (!response.ok) throw new Error('The saved call result could not be read.');
    return rowsFromSql(await response.json()).filter(row => field(row, 'sessionId') === sessionId);
  }

  let refusalNotified = false;
  function source({ mapBinding, signal, onUpdate, onUnavailable, onReady, callSessionId }) {
    let timer = 0;
    let stopped = false;
    let polling = false;
    let seen = -1;
    const sessionId = callSessionId || mapBinding.sessionId;
    const stop = () => { stopped = true; cancelPoll(timer); };
    signal?.addEventListener?.('abort', stop);
    const tick = async () => {
      if (stopped || polling) return;
      polling = true;
      try {
        const token = await clientToken();
        const found = await summaries(token, sessionId);
        if (stopped) return;
        onReady();
        const row = found.sort((a, b) => Number(field(a, 'revision')) - Number(field(b, 'revision'))).at(-1);
        if (!row) return;
        const revision = Number(field(row, 'revision'));
        if (revision === seen) return;
        const update = projectNegotiationResult(row, mapBinding);
        const result = onUpdate(update);
        if (result?.status === 'applied') {
          seen = revision;
          const summary = update.summary;
          const confirmedRefusal = update.phase === 'finished' && update.mode === 'live' && summary?.outcome === 'refused'
            && CONFIRMED_REFUSAL_REASONS.includes(summary.reason);
          if (confirmedRefusal) {
            lockLiveCall();
            try {
              onConfirmedRefusal(update);
              refusalNotified = true;
            } catch {
              // The saved explanation stays visible when the route update fails.
            }
          }
          if (update.phase === 'finished') stop();
        }
      } catch {
        if (!stopped && !refusalNotified) onUnavailable();
      } finally {
        polling = false;
      }
    };
    tick();
    timer = schedulePoll(tick, 2000);
    return stop;
  }

  async function handle({ handoff, participant, signal, call }) {
    if (signal?.aborted) throw new Error('The call request was cancelled.');
    const args = buildDialArgs(handoff, participant, call?.sessionId);
    const token = await clientToken();
    if (call?.previousSessionId) {
      let resetOk = false;
      try {
        const reset = await fetchImpl(`${origin}/v1/database/${database}/call/reset_demo_call`, {
          method: 'POST',
          signal,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify([call.previousSessionId]),
        });
        resetOk = reset.ok === true;
      } catch {
        if (signal?.aborted) throw new Error('The call request was cancelled.');
        resetOk = false;
      }
      if (!resetOk && call.previousOpen) throw new Error('The previous call is still open.');
    }
    const response = await fetchImpl(`${origin}/v1/database/${database}/call/start_call`, {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        args.sessionId, args.phone, true, args.projectBudgetCents, args.requestKey, args.parcelId,
        args.ownerAlias, args.towerCount, args.lineLengthMillis, args.recommendedOfferCents,
        args.offerCapCents, args.monthlyRentCents,
      ]),
    });
    if (!response.ok) throw new Error('The call request was not accepted.');
    const callSessionId = args.sessionId;
    installSource(options => source({ ...options, callSessionId }));
  }

  return { handle, source, buildDialArgs };
}
