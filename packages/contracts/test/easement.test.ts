import test from 'node:test';
import assert from 'node:assert/strict';
import { createEasementDraft, awaitDemoSignature, demoSign } from '../src/easement.ts';
import { NegotiationResult } from '../src/schemas.ts';

const negotiation = NegotiationResult.parse({
  schemaVersion: 1, sourceMode: 'fixture', evidenceRefs: ['synthetic-consent'],
  id: 'neg-1', projectId: 'demo-project', parcelId: 'parcel-1',
  routeVersion: 1, termsVersion: 1, sessionId: 'session-1',
  outcome: 'accepted', accessConsent: 'allowed', explicitConfirmation: true,
  upfrontCents: 100000, depositCents: 20000, depositCreditPolicy: 'credited_to_upfront',
  monthlyRentCents: 5000, termMonths: 2, conditions: ['Daytime access only'],
});
const input = {
  id: 'contract-1', projectId: 'demo-project', routeId: 'route-1', parcelId: 'parcel-1',
  contractVersion: 1, templateVersion: 'demo-v1', ownerAlias: 'Synthetic Owner',
  operatorAlias: 'Demo Grid Operator', corridorDescription: 'Synthetic 10m corridor',
  accessConditions: ['Daytime access only'], effectiveStartDate: '2026-11-01',
  effectiveEndDate: '2026-12-31', negotiation, offerCapCents: 100000,
};
test('accepted terms create immutable preview and demo receipt', () => {
  const draft = createEasementDraft(input);
  assert.deepEqual(draft.missingFields, []);
  assert.ok(draft.contract);
  assert.match(draft.preview, /DEMO ONLY/);
  assert.match(draft.contract.contentHash, /^sha256:[a-f0-9]{64}$/);
  const awaiting = awaitDemoSignature(draft.contract);
  const signed = demoSign(awaiting, 'Synthetic Owner', '2026-10-24T10:00:00Z');
  assert.equal(signed.easement.status, 'demo_signed');
  assert.equal(signed.receipt.simulation, true);
  assert.throws(() => demoSign(signed.easement, 'Synthetic Owner', '2026-10-24T10:01:00Z'));
});
test('missing terms block readiness', () => {
  const result = createEasementDraft({ ...input, corridorDescription: '', accessConditions: [] });
  assert.equal(result.contract, null);
  assert.ok(result.missingFields.includes('corridorDescription'));
});
test('regeneration supersedes prior version', () => {
  const prior = createEasementDraft(input).contract!;
  const next = createEasementDraft({ ...input, id: 'contract-2', contractVersion: 2, priorContract: prior });
  assert.equal(next.supersededContract?.status, 'superseded');
  assert.equal(next.contract?.contractVersion, 2);
});

test('end date must match negotiated full calendar months', () => {
  const result = createEasementDraft({ ...input, effectiveEndDate: '2027-01-31' });
  assert.equal(result.contract, null);
  assert.ok(result.missingFields.includes('termDateMismatch'));
});
test('invalid calendar dates block contract readiness', () => {
  const result = createEasementDraft({ ...input, effectiveStartDate: '2026-13-01' });
  assert.equal(result.contract, null);
  assert.ok(result.missingFields.includes('effectiveDates'));
});
test('unaccepted negotiation cannot create a signable contract', () => {
  const refused = NegotiationResult.parse({ ...negotiation, outcome: 'refused', accessConsent: 'refused', explicitConfirmation: false });
  const result = createEasementDraft({ ...input, negotiation: refused });
  assert.equal(result.contract, null);
  assert.ok(result.missingFields.includes('acceptedNegotiation'));
});
test('draft cannot be signed before entering awaiting state', () => {
  const draft = createEasementDraft(input).contract!;
  assert.throws(() => demoSign(draft, 'Synthetic Owner', '2026-10-24T10:00:00Z'));
});
