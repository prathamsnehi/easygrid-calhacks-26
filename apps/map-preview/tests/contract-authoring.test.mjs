import test from 'node:test';
import assert from 'node:assert/strict';
import {createContractExample} from '../src/contract-fixtures.js';
import {validateContractSource, normalizeContractSource, contractSourceKey, createContractDraft, updateContractDraft, validateContractDraft, compensationPayment, contractDocument, renderContractDocument, exportContractHTML, createContractDraftStore} from '../src/contract-authoring.js';

const now = '2026-10-24T18:00:00Z';
const create = (source = createContractExample(), parcelId = 'P-004') => createContractDraft(source, parcelId, {now, id:`draft-${parcelId}`});

test('only complete approved negotiations for every final-route parcel enable contract authoring', () => {
  assert.equal(validateContractSource(createContractExample()).valid, true);
  for (const status of ['pending','refused']) {
    assert.equal(validateContractSource(createContractExample(status)).valid, false);
    assert.throws(() => create(createContractExample(status)), /approved/);
  }
  for (const mutate of [s => s.parcels[1].accepted = false, s => s.parcels[0].compensationCents = null,
    s => s.parcels[0].compensationCents = 0.1, s => s.route.version = 0, s => s.parcels.push({...s.parcels[0]}),
    s => s.sourceMode = 'live', s => s.parcels[0].accessTerms = '', s => s.parcels.forEach(p => p.compensationCents = Number.MAX_SAFE_INTEGER)]) {
    const source = createContractExample(); mutate(source); assert.equal(validateContractSource(source).valid, false);
  }
});

test('normalization drops transcripts, contact and banking extras and does not mutate input', () => {
  const source = createContractExample();
  source.transcript = 'private transcript'; source.participant = {phone:'private-number'};
  source.parcels[0].bankAccount = 'private-bank-account';
  const before = JSON.stringify(source), normalized = normalizeContractSource(source), serialized = JSON.stringify(normalized);
  assert.equal(JSON.stringify(source), before);
  for (const secret of ['private transcript','private-number','private-bank-account']) assert(!serialized.includes(secret));
  assert.equal(contractSourceKey(normalized), contractSourceKey(source));
});

test('the full approved compensation is paid once after signatures, including exact odd cents', () => {
  const source = createContractExample(), draft = create(source), document = contractDocument(draft, source);
  assert.equal(document.paymentCents, 1200000);
  assert.equal(document.paymentSchedule, 'full-after-signatures');
  for (const field of ['initialCents','completionCents','monthlyFeeCents']) assert.equal(Object.hasOwn(document, field), false);
  assert.deepEqual(compensationPayment(10003), {totalCents:10003, paymentCents:10003, paymentSchedule:'full-after-signatures'});
  assert.throws(() => compensationPayment(-1));
  const html = renderContractDocument(draft, source);
  assert.doesNotMatch(html, /Monthly usage fee|monthly anniversaries|20%|Completion balance|Initial payment/);
  for (const value of ['$12,000.00','Full compensation · 100%','One payment after all final-route agreements are signed','Awaiting click signature']) assert(html.includes(value));
});

test('the full payment schedule is canonical and invalidates previously staged drafts', () => {
  const source = createContractExample(), draft = create(source);
  const legacy = {...source}; delete legacy.paymentSchedule;
  assert.equal(normalizeContractSource(legacy).paymentSchedule, 'full-after-signatures');
  assert.equal(contractSourceKey(legacy), contractSourceKey(source));
  const oldBinding = JSON.parse(draft.sourceKey); delete oldBinding.paymentSchedule;
  assert.equal(validateContractDraft({...draft,sourceKey:JSON.stringify(oldBinding)}, source).valid, false);
  assert.equal(validateContractSource({...source,paymentSchedule:'20-80'}).valid, false);
});

test('draft changes cannot alter approved money, owner, parcel or source bindings', () => {
  const source = createContractExample(), draft = create(source);
  const updated = updateContractDraft(draft, {specialConditions:'Reviewer note only.'}, source, now);
  assert.equal(updated.version, 2); assert.equal(draft.version, 1);
  assert.throws(() => updateContractDraft(draft, {compensationCents:1}, source, now), /cannot be edited/);
  assert.throws(() => updateContractDraft(draft, {agreementDate:'2026-02-30'}, source, now), /valid agreement date/);
  assert.throws(() => updateContractDraft(draft, {developerName:''}, source, now), /Developer name/);
  for (const mutate of [s => s.route.version++, s => s.negotiation.version++, s => s.parcels[0].termsVersion++, s => s.parcels[0].compensationCents++]) {
    const changed = createContractExample(); mutate(changed); assert.equal(validateContractDraft(draft, changed).valid, false);
  }
});

test('downloaded HTML escapes author input and has no active scripts or external dependencies', () => {
  const source = createContractExample(), draft = updateContractDraft(create(source), {developerName:'<script>alert(1)</script>', accessTerms:'Proposed reviewer description.', specialConditions:'</style><img src=x onerror=alert(1)>'}, source, now);
  const html = exportContractHTML(draft, source);
  assert(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;')); assert(!html.includes('<script>'));
  assert(!html.includes('<img src=x')); assert(html.includes('Content-Security-Policy'));
  assert(html.includes('Approved terms:')); assert(html.includes('Draft access description:'));
});

test('the review document shows confirmed terms once and omits empty reviewer notes', () => {
  const source = createContractExample(), html = renderContractDocument(create(source), source);
  assert.equal(html.split(source.parcels[0].accessTerms).length - 1, 1);
  assert(!html.includes('Draft access description:'));
  assert(!html.includes('Reviewer notes'));
  for (const value of [source.project.name,source.parcels[0].ownerName,'P-004','Oct 24, 2026','$12,000.00']) assert(html.includes(value));
});

test('representative names are approved inputs and signatures appear only after simulated signing', () => {
  const source = createContractExample(), draft = create(source), doc = contractDocument(draft, source);
  assert.equal(doc.developerName, 'EasyGrid');
  assert.equal(doc.developerSignerName, 'Ethan Cole');
  assert.equal(doc.ownerSignerName, 'Olivia Bennett');
  assert(!renderContractDocument(draft, source).includes('class="cg-autograph '));
  const execution = {signatures:{utility:{simulated:true,signedAt:now}}};
  const html = renderContractDocument(draft, source, execution);
  assert(html.includes('Simulated signature by Ethan Cole'));
  assert(!html.includes('Simulated signature by Olivia Bennett'));
  assert(exportContractHTML(draft, source, execution).includes('.cg-autograph{'));
  for (const mutate of [s => s.project.signerName = 'Different representative', s => s.parcels[0].signerName = 'Different owner']) {
    const changed = createContractExample(); mutate(changed);
    assert.equal(validateContractDraft(draft, changed).valid, false);
  }
  for (const mutate of [s => s.project.signerName = '', s => s.parcels[0].signerName = 42]) {
    const invalid = createContractExample(); mutate(invalid);
    assert.equal(validateContractSource(invalid).valid, false);
  }
  source.project.signerName = '<img src=x onerror=alert(1)>';
  const escaped = renderContractDocument(create(source), source, execution);
  assert(!escaped.includes('<img'));
  assert(escaped.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('sources without representatives preserve their canonical document fields', () => {
  const source = createContractExample();
  delete source.project.signerName;
  source.parcels.forEach(p => delete p.signerName);
  const normalized = normalizeContractSource(source), doc = contractDocument(create(source), source);
  assert(!Object.hasOwn(normalized.project, 'signerName'));
  assert(!Object.hasOwn(normalized.parcels[0], 'signerName'));
  assert(!Object.hasOwn(doc, 'developerSignerName'));
  assert(!Object.hasOwn(doc, 'ownerSignerName'));
});

test('saved drafts restore per parcel and reject stale, corrupt, mismatched or unavailable storage', () => {
  const data = new Map(), storage = {getItem:k => data.get(k) ?? null, setItem:(k,v) => data.set(k,v)}, store = createContractDraftStore(storage);
  const source = createContractExample(), draft = create(source);
  assert.equal(store.load(source,'P-004').status,'empty'); store.save(draft, source);
  assert.deepEqual(store.load(source,'P-004').draft, draft);
  const changed = createContractExample(); changed.route.version++; assert.equal(store.load(changed,'P-004').status,'stale');
  const [key] = data.keys(); data.set(key, JSON.stringify(create(source,'P-009'))); assert.equal(store.load(source,'P-004').status,'stale');
  data.set(key,'{'); assert.equal(store.load(source,'P-004').status,'unavailable');
  assert.throws(() => createContractDraftStore(null).save(draft,source), /unavailable/);
});

test('representative demo copy scopes payment timing without changing approved document bindings', () => {
  const source=createContractExample(), draft=create(source), before=contractDocument(draft,source);
  const execution={demoScope:'single-owner',demoParcelId:draft.parcelId};
  const html=renderContractDocument(draft,source,execution), exported=exportContractHTML(draft,source,execution);
  for (const text of [html,exported]) {
    assert.match(text,/SINGLE-LANDOWNER DEMO/);
    assert.match(text,/One payment after both parties sign this agreement/);
    assert.match(text,/Other landowners are outside this example/);
    assert.doesNotMatch(text,/every current final-route agreement|after all final-route agreements are signed/);
    assert.match(text,/\$12,000\.00/);
  }
  assert.deepEqual(contractDocument(draft,source),before);
  assert.match(renderContractDocument(draft,source,{...execution,demoParcelId:'P-009'}),/all final-route agreements/,'other parcel metadata cannot scope this agreement');
});

test('a single-owner approval preserves the full route while authorizing only its accepted parcel', () => {
  const source=createContractExample();
  source.approvalScope={kind:'single-owner',parcelId:'P-004'};
  source.parcels[1].accepted=false;
  const before=JSON.stringify(source), normalized=normalizeContractSource(source), draft=create(source);
  assert.equal(JSON.stringify(source),before);
  assert.deepEqual(normalized.approvalScope,source.approvalScope);
  assert.deepEqual(normalized.parcels,source.parcels);
  assert.equal(normalized.parcels.length,2);
  assert.equal(normalized.parcels[1].accepted,false);
  assert.equal(validateContractDraft(draft,source).valid,true);
  assert.deepEqual(contractDocument(draft,source).approvalScope,source.approvalScope);
  assert.match(renderContractDocument(draft,source),/One payment after both parties sign this agreement/);
  assert.throws(() => create(source,'P-009'),/accepted parcel within the current approval scope/);
  assert.equal(validateContractDraft({...draft,parcelId:'P-009'},source).valid,false);
  source.parcels[1].accepted=true;
  assert.throws(() => create(source,'P-009'),/approval scope/,'another accepted owner is still outside the selected scope');
  assert.equal(validateContractDraft({...draft,parcelId:'P-009',sourceKey:contractSourceKey(source)},source).valid,false);
});

test('scoped approval and every retained parcel remain part of the canonical draft binding', () => {
  const source=createContractExample(), legacyKey=contractSourceKey(source), legacyDraft=create(source);
  assert.equal(legacyKey,JSON.stringify(source),'sources without scope keep their exact canonical serialization');
  assert.equal(Object.hasOwn(normalizeContractSource(source),'approvalScope'),false);
  assert.equal(Object.hasOwn(contractDocument(legacyDraft,source),'approvalScope'),false);
  source.approvalScope={kind:'single-owner',parcelId:'P-004'};
  const draft=create(source);
  assert.notEqual(draft.sourceKey,legacyKey);
  assert.equal(validateContractDraft(legacyDraft,source).valid,false);
  for (const mutate of [s => s.approvalScope.parcelId='P-009',s => delete s.approvalScope,
    s => s.parcels[1].accepted=false,s => s.parcels[1].termsVersion++,s => s.parcels[1].compensationCents++]) {
    const changed=structuredClone(source);mutate(changed);
    assert.equal(validateContractDraft(draft,changed).valid,false);
  }
});

test('scoped sources still reject missing acceptance, invalid pending terms and malformed scope', () => {
  const valid=() => {
    const source=createContractExample();source.approvalScope={kind:'single-owner',parcelId:'P-004'};
    source.parcels[1].accepted=false;return source;
  };
  for (const mutate of [s => s.approvalScope=null,s => s.approvalScope={kind:'all',parcelId:'P-004'},
    s => s.approvalScope.parcelId='missing',s => s.parcels[0].accepted=false,
    s => delete s.parcels[1].accepted,s => s.parcels[1].accepted='false',
    s => s.parcels[1].compensationCents=1.5,s => s.parcels[1].compensationCents=-1,
    s => s.parcels[1].termsVersion=0,s => s.parcels[1].ownerId='',s => {s.parcels.pop();s.approvalScope.parcelId='P-009';}]) {
    const source=valid();mutate(source);
    assert.equal(validateContractSource(source).valid,false);
    assert.throws(() => normalizeContractSource(source));
  }
});
