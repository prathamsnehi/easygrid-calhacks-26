import { DEMO_METERS_PER_TILE } from './cost-model.js';

const ORIGIN = 'https://maincloud.spacetimedb.com';
const DATABASE = 'easygrid-demo';
const TOKEN_KEY = 'easygrid-demo-client-token';

export function buildDialArgs(handoff, participant) {
  const parcelId = handoff?.userRole?.parcelId;
  const row = handoff?.parcelAnalysis?.find(item => item.parcelId === parcelId);
  if (!handoff?.sessionId || !row || !parcelId) throw new Error('Register the participant on a current route before calling.');
  if (!Number.isInteger(row.towerCount) || row.towerCount <= 0) throw new Error('This parcel has no tower to negotiate.');
  if (participant?.consent !== true) throw new Error('A live call requires the participant consent checkbox.');
  const phone = String(participant.phoneE164 || participant.phone || '');
  const packet = handoff.ownerHandoff?.parcels?.find(item => item.parcelId === parcelId);
  const monthlyRentCents = row.monthlyRentCents ?? row.monthlyRentEquivalentCents ?? packet?.terms?.monthlyRentCents;
  const line = Math.round(Number(row.lineLengthTiles) * DEMO_METERS_PER_TILE * 1000);
  return {
    sessionId: handoff.sessionId,
    phone,
    consent: true,
    projectBudgetCents: handoff.ownerHandoff.budgetCents,
    requestKey: `dial-${handoff.sessionId}`.slice(0, 120),
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

export function projectNegotiationResult(row, mapBinding) {
  const attemptId = String(field(row, 'attemptId') ?? '');
  const phase = field(row, 'phase');
  const mode = field(row, 'mode');
  const revision = Number(field(row, 'revision'));
  const finished = phase === 'finished';
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
    summary: finished ? {
      attemptId,
      mode,
      reason: field(row, 'reason'),
      disposition: field(row, 'disposition'),
      explanation: field(row, 'explanation'),
      nextAction: field(row, 'nextAction'),
      outcome: field(row, 'outcome'),
    } : null,
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

  function source({ mapBinding, signal, onUpdate, onUnavailable, onReady }) {
    let timer = 0;
    let stopped = false;
    let seen = -1;
    const stop = () => { stopped = true; clearInterval(timer); };
    signal?.addEventListener?.('abort', stop);
    const tick = async () => {
      if (stopped) return;
      try {
        const token = await clientToken();
        const found = await summaries(token, mapBinding.sessionId);
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
          if (update.summary?.reason === 'ACCESS_REFUSED' || update.summary?.reason === 'DO_NOT_CALL') lockLiveCall();
          if (update.phase === 'finished') stop();
        }
      } catch {
        if (!stopped) onUnavailable();
      }
    };
    tick();
    timer = setInterval(tick, 2000);
    return stop;
  }

  async function handle({ handoff, participant, signal }) {
    if (signal?.aborted) throw new Error('The call request was cancelled.');
    const args = buildDialArgs(handoff, participant);
    const token = await clientToken();
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
    installSource(source);
  }

  return { handle, source, buildDialArgs };
}
