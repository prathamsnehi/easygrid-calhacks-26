import { SenderError, type ViewCtx, type InferSchema } from 'spacetimedb/server';
import { Id, canonicalJson, negotiationAgreementPacket, type OwnerHandoff } from '@easygrid/contracts';
import { spacetimedb } from './tables.ts';
import type { Db } from './logic.ts';
import { canReadNegotiation } from './negotiation-state.ts';

type Reader = Pick<ViewCtx<InferSchema<typeof spacetimedb>>, 'db' | 'sender'>;
type Signature = { ownerId: string; requestKey: string };
type Payment = { parcelId: string; ownerId: string; amountCents: number; paymentRecipientRef: string; requestKey: string };
type SettlementBody = {
  revision: number;
  routeId: string;
  routeVersion: number;
  fingerprint: string;
  utilityRequestKey: string | null;
  owners: Signature[];
  approvedRequestKey: string | null;
  payments: Payment[];
};

function fail(code: string, message: string): never { throw new SenderError(`${code}: ${message}`); }
function requireState(value: unknown, message: string): asserts value {
  if (!value) fail('BLOCKED_STATE', message);
}
function encoded(input: unknown): string {
  const result = JSON.stringify(input);
  if (result.length > 4_000_000) fail('INVALID_INPUT', 'The settlement payload is too large.');
  return result;
}
function worker(ctx: Reader, sessionId: string) {
  const row = ctx.db.session.sessionId.find(sessionId);
  if (!row) fail('NOT_FOUND', 'The session does not exist.');
  if (!row.workerIdentity || row.workerIdentity !== ctx.sender.toHexString()) fail('FORBIDDEN', 'The registered session worker is required.');
  return row;
}
function readyPacket(ctx: Reader, sessionId: string): OwnerHandoff {
  const row = ctx.db.negotiationSession.sessionId.find(sessionId);
  if (!row) fail('NOT_FOUND', 'The map has not been bound to negotiation state.');
  let packet: OwnerHandoff;
  try { packet = negotiationAgreementPacket(JSON.parse(row.stateJson)); }
  catch { return fail('BLOCKED_STATE', 'Every current affected parcel must accept before settlement.'); }
  requireState(packet.referenceBinding === 'canonical', 'Settlement requires the canonical agreement packet.');
  requireState(packet.parcels.every(parcel => parcel.terms.outcome === 'accepted' && parcel.terms.compensationCents > 0),
    'Only priced accepted parcels can be settled.');
  requireState(packet.owners.every(owner => owner.banking.ownerId === owner.ownerId && owner.banking.mode === 'simulated' &&
    owner.banking.paymentRecipientRef.startsWith('mock-')), 'Each owner must keep the original simulated banking destination.');
  return packet;
}
function fingerprint(packet: OwnerHandoff): string {
  return canonicalJson({
    sessionId: packet.sessionId, projectId: packet.projectId, routeId: packet.routeId, routeVersion: packet.routeVersion, revision: packet.revision,
    parcels: packet.parcels.map(parcel => ({ parcelId: parcel.parcelId, ownerId: parcel.ownerId, termsVersion: parcel.terms.termsVersion,
      compensationCents: parcel.terms.compensationCents })).sort((a, b) => a.parcelId.localeCompare(b.parcelId)),
    banking: packet.owners.map(owner => ({ ownerId: owner.ownerId, paymentRecipientRef: owner.banking.paymentRecipientRef }))
      .sort((a, b) => a.ownerId.localeCompare(b.ownerId)),
  });
}
function load(ctx: Reader, sessionId: string, expectedRevision: number) {
  const packet = readyPacket(ctx, sessionId);
  if (packet.revision !== expectedRevision) fail('STALE_VERSION', 'The agreement revision changed.');
  const row = ctx.db.settlementRecord.sessionId.find(sessionId);
  const mark = fingerprint(packet);
  if (row && row.fingerprint !== mark) fail('STALE_VERSION', 'The accepted route, terms or banking destination changed.');
  const body: SettlementBody = row ? JSON.parse(row.stateJson) : {
    revision: packet.revision, routeId: packet.routeId, routeVersion: packet.routeVersion, fingerprint: mark,
    utilityRequestKey: null, owners: [], approvedRequestKey: null, payments: [],
  };
  return { packet, row, body, mark };
}
function statusOf(body: SettlementBody, parcelCount: number): string {
  if (body.payments.length === parcelCount) return 'paid';
  if (body.approvedRequestKey) return 'approved';
  if (body.utilityRequestKey && body.owners.length) return 'signing';
  return 'opened';
}
function save(ctx: Db, sessionId: string, packet: OwnerHandoff, body: SettlementBody): void {
  const next = {
    sessionId, revision: packet.revision, routeVersion: packet.routeVersion, fingerprint: body.fingerprint,
    status: statusOf(body, packet.parcels.length), stateJson: encoded(body),
  };
  const existing = ctx.db.settlementRecord.sessionId.find(sessionId);
  if (existing) ctx.db.settlementRecord.sessionId.update(next);
  else ctx.db.settlementRecord.insert(next);
}
function sameSignature(prior: string | null, requestKey: string): boolean {
  if (prior === null) return false;
  if (prior !== requestKey) fail('IDEMPOTENCY_CONFLICT', 'This signature was already recorded with a different request.');
  return true;
}

/** Open settlement only from the saved all-parcel canonical packet. Browser packets are ignored. */
export function openSettlement(ctx: Db, input: { sessionId: string; expectedRevision: number }): void {
  worker(ctx, input.sessionId);
  const { packet, row, body } = load(ctx, input.sessionId, input.expectedRevision);
  if (row) return;
  save(ctx, input.sessionId, packet, body);
}
export function signSettlement(ctx: Db, input: { sessionId: string; expectedRevision: number; role: string; ownerId: string; requestKey: string }): void {
  worker(ctx, input.sessionId);
  try { Id.parse(input.requestKey); } catch { fail('INVALID_INPUT', 'The signature request key is invalid.'); }
  const { packet, row, body } = load(ctx, input.sessionId, input.expectedRevision);
  requireState(row, 'Open the canonical settlement before recording a signature.');
  if (input.role === 'utility') {
    requireState(input.ownerId === '', 'The utility signature has no landowner.');
    if (sameSignature(body.utilityRequestKey, input.requestKey)) return;
    body.utilityRequestKey = input.requestKey;
  } else if (input.role === 'owner') {
    requireState(packet.owners.some(owner => owner.ownerId === input.ownerId), 'The signer is not an owner on the accepted route.');
    const prior = body.owners.find(owner => owner.ownerId === input.ownerId);
    if (prior) {
      if (prior.requestKey !== input.requestKey) fail('IDEMPOTENCY_CONFLICT', 'This owner signature was already recorded with a different request.');
      return;
    }
    body.owners.push({ ownerId: input.ownerId, requestKey: input.requestKey });
  } else fail('INVALID_INPUT', 'The signature role must be utility or owner.');
  save(ctx, input.sessionId, packet, body);
}
export function approveSettlement(ctx: Db, input: { sessionId: string; expectedRevision: number; requestKey: string }): void {
  worker(ctx, input.sessionId);
  try { Id.parse(input.requestKey); } catch { fail('INVALID_INPUT', 'The approval request key is invalid.'); }
  const { packet, row, body } = load(ctx, input.sessionId, input.expectedRevision);
  requireState(row && body.utilityRequestKey && packet.owners.every(owner => body.owners.some(signature => signature.ownerId === owner.ownerId)),
    'Utility approval and every current owner signature are required.');
  if (body.approvedRequestKey) {
    if (body.approvedRequestKey !== input.requestKey) fail('IDEMPOTENCY_CONFLICT', 'This approval was already recorded with a different request.');
    return;
  }
  body.approvedRequestKey = input.requestKey;
  save(ctx, input.sessionId, packet, body);
}
export function paySettlement(ctx: Db, input: {
  sessionId: string; expectedRevision: number; parcelId: string; amountCents: number; paymentRecipientRef: string; requestKey: string;
}): void {
  worker(ctx, input.sessionId);
  try { Id.parse(input.requestKey); } catch { fail('INVALID_INPUT', 'The payment request key is invalid.'); }
  const { packet, row, body } = load(ctx, input.sessionId, input.expectedRevision);
  requireState(row && body.approvedRequestKey, 'Settlement must be approved before payment.');
  const parcel = packet.parcels.find(item => item.parcelId === input.parcelId);
  requireState(parcel, 'Refused or excluded parcels receive no settlement.');
  const owner = packet.owners.find(item => item.ownerId === parcel.ownerId);
  requireState(owner && input.paymentRecipientRef === owner.banking.paymentRecipientRef, 'The banking destination does not match the current owner.');
  requireState(Number.isSafeInteger(input.amountCents) && input.amountCents === parcel.terms.compensationCents,
    'The payment must equal the exact accepted compensation.');
  const prior = body.payments.find(payment => payment.parcelId === parcel.parcelId);
  if (prior) {
    requireState(prior.requestKey === input.requestKey && prior.amountCents === input.amountCents && prior.paymentRecipientRef === input.paymentRecipientRef,
      'This parcel already has a different payment.');
    return;
  }
  body.payments.push({ parcelId: parcel.parcelId, ownerId: parcel.ownerId, amountCents: input.amountCents,
    paymentRecipientRef: input.paymentRecipientRef, requestKey: input.requestKey });
  save(ctx, input.sessionId, packet, body);
}
export function settlementStatus(ctx: Reader, sessionId: string) {
  if (!canReadNegotiation(ctx, sessionId)) return [];
  const row = ctx.db.settlementRecord.sessionId.find(sessionId);
  if (!row) return [];
  const body = JSON.parse(row.stateJson) as SettlementBody;
  return [{ revision: row.revision, status: row.status, stateJson: encoded({
    revision: body.revision, routeId: body.routeId, routeVersion: body.routeVersion, approved: body.approvedRequestKey !== null,
    signatures: [
      ...(body.utilityRequestKey ? [{ role: 'utility', ownerId: null }] : []),
      ...body.owners.map(owner => ({ role: 'owner', ownerId: owner.ownerId })),
    ],
    payments: body.payments.map(payment => ({ parcelId: payment.parcelId, ownerId: payment.ownerId, amountCents: payment.amountCents,
      paymentRecipientRef: payment.paymentRecipientRef })),
  }) }];
}
