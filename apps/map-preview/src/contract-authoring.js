/** CAL-36 development boundary. This fixture shape is not the team's final SpacetimeDB schema. */
const clone = value => JSON.parse(JSON.stringify(value));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const text = (value, max = 4000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const validId = value => typeof value === 'string' && ID.test(value);
const version = value => Number.isSafeInteger(value) && value > 0;
const cents = value => Number.isSafeInteger(value) && value >= 0;
const dateOnly = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const DRAFT_FIELDS = ['developerName', 'agreementDate', 'accessTerms', 'specialConditions'];
export const CONTRACT_STORAGE_PREFIX = 'easygrid.contract-authoring.v1:';

export function money(centsValue) {
  return new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'}).format(centsValue / 100);
}

export function validateContractSource(input) {
  const errors = [];
  if (!input || typeof input !== 'object') return {valid: false, errors: ['Approved negotiation details are required.']};
  if (input.sourceMode !== 'fixture') errors.push('This development editor accepts fictional example data only.');
  if (!validId(input.sessionId)) errors.push('A demo session ID is required.');
  if (!validId(input.route?.id) || !version(input.route?.version) || !text(input.route?.name, 160)) errors.push('A versioned final route is required.');
  if (!text(input.project?.name, 160) || !text(input.project?.developerName, 160)) errors.push('Project and developer names are required.');
  if (input.negotiation?.status !== 'approved') errors.push('Negotiation must be approved before starting a contract.');
  if (!validId(input.negotiation?.id) || !version(input.negotiation?.version) || !timestamp(input.negotiation?.approvedAt)) errors.push('The approved negotiation needs an ID, version and approval time.');
  if (!Array.isArray(input.parcels) || input.parcels.length === 0 || input.parcels.length > 100) errors.push('The final route must include between 1 and 100 parcels.');
  else {
    const ids = new Set();
    for (const parcel of input.parcels) {
      if (!parcel || !validId(parcel.parcelId) || ids.has(parcel.parcelId)) errors.push('Each parcel needs a unique parcel ID.');
      ids.add(parcel?.parcelId);
      if (!validId(parcel?.ownerId) || !text(parcel?.ownerName, 160) || !text(parcel?.landDescription, 1000)) errors.push('Each parcel needs a fictional owner and land description.');
      if (parcel?.accepted !== true) errors.push('Every parcel on the final route must have accepted terms.');
      if (!version(parcel?.termsVersion) || !text(parcel?.accessTerms)) errors.push('Each parcel needs versioned access terms.');
      if (!cents(parcel?.compensationCents)) errors.push('Approved compensation must be non-negative integer cents.');
    }
    if (!Number.isSafeInteger(input.parcels.reduce((sum, p) => sum + (cents(p?.compensationCents) ? p.compensationCents : 0), 0))) errors.push('The approved package total exceeds the supported range.');
  }
  return {valid: errors.length === 0, errors: [...new Set(errors)]};
}

/** Whitelist only contract inputs; raw transcripts, phone numbers and banking data never enter a draft. */
export function normalizeContractSource(input) {
  const result = validateContractSource(input);
  if (!result.valid) throw new Error(result.errors.join(' '));
  return {
    sourceMode: 'fixture', sessionId: input.sessionId,
    project: {name: input.project.name.trim(), developerName: input.project.developerName.trim()},
    route: {id: input.route.id, version: input.route.version, name: input.route.name.trim()},
    negotiation: {id: input.negotiation.id, version: input.negotiation.version, status: 'approved', approvedAt: input.negotiation.approvedAt},
    parcels: input.parcels.map(p => ({parcelId: p.parcelId, ownerId: p.ownerId, ownerName: p.ownerName.trim(),
      landDescription: p.landDescription.trim(), accepted: true, termsVersion: p.termsVersion,
      compensationCents: p.compensationCents, accessTerms: p.accessTerms.trim()}))
      .sort((a, b) => a.parcelId.localeCompare(b.parcelId)),
  };
}

export function contractSourceKey(input) { return JSON.stringify(normalizeContractSource(input)); }

export function compensationSplit(totalCents) {
  if (!cents(totalCents)) throw new Error('Compensation must be integer cents.');
  const initialCents = Math.floor(totalCents / 5);
  return {totalCents, initialCents, completionCents: totalCents - initialCents};
}

export function createContractDraft(input, parcelId, {now = new Date().toISOString(), id = `draft-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`}`} = {}) {
  const source = normalizeContractSource(input), parcel = source.parcels.find(p => p.parcelId === parcelId);
  if (!parcel) throw new Error('The parcel is not on the approved final route.');
  if (!timestamp(now) || !validId(id)) throw new Error('A valid draft ID and creation time are required.');
  return {schemaVersion: 1, id, status: 'draft', version: 1, parcelId, sourceKey: contractSourceKey(source),
    createdAt: now, updatedAt: now,
    fields: {developerName: source.project.developerName, agreementDate: source.negotiation.approvedAt.slice(0, 10), accessTerms: parcel.accessTerms, specialConditions: ''}};
}

export function validateContractDraft(draft, input) {
  let sourceKey;
  try { sourceKey = contractSourceKey(input); } catch (error) { return {valid: false, errors: [error.message]}; }
  const errors = [];
  if (!draft || draft.schemaVersion !== 1 || !validId(draft.id) || draft.status !== 'draft' || !version(draft.version) || !timestamp(draft.createdAt) || !timestamp(draft.updatedAt)) errors.push('This saved draft is invalid.');
  if (draft?.sourceKey !== sourceKey || !input.parcels.some(p => p.parcelId === draft?.parcelId)) errors.push('The negotiation or route changed. Start a new draft from the current approval.');
  if (!text(draft?.fields?.developerName, 160)) errors.push('Developer name is required (maximum 160 characters).');
  if (!dateOnly(draft?.fields?.agreementDate)) errors.push('Enter a valid agreement date.');
  if (!text(draft?.fields?.accessTerms)) errors.push('Access description is required (maximum 4,000 characters).');
  if (typeof draft?.fields?.specialConditions !== 'string' || draft.fields.specialConditions.length > 4000) errors.push('Draft notes must be at most 4,000 characters.');
  return {valid: errors.length === 0, errors};
}

export function updateContractDraft(draft, changes, input, now = new Date().toISOString()) {
  if (!validateContractDraft(draft, input).valid) throw new Error('The saved draft no longer matches the current approved negotiation.');
  if (!timestamp(now) || Object.keys(changes).some(key => !DRAFT_FIELDS.includes(key))) throw new Error('Approved financial and owner terms cannot be edited in the draft.');
  const next = {...clone(draft), version: draft.version + 1, updatedAt: now, fields: {...draft.fields, ...changes}};
  const validation = validateContractDraft(next, input);
  if (!validation.valid) throw new Error(validation.errors.join(' '));
  return next;
}

export function contractDocument(draft, input) {
  const source = normalizeContractSource(input), validation = validateContractDraft(draft, source);
  if (!validation.valid) throw new Error(validation.errors.join(' '));
  const parcel = source.parcels.find(p => p.parcelId === draft.parcelId), split = compensationSplit(parcel.compensationCents);
  return {title: 'Land-use agreement', reference: `${source.negotiation.id} / ${parcel.parcelId}`,
    ownerName: parcel.ownerName, developerName: draft.fields.developerName,
    projectName: source.project.name, agreementDate: draft.fields.agreementDate,
    parcelId: parcel.parcelId, ownerId: parcel.ownerId, landDescription: parcel.landDescription,
    routeName: source.route.name, routeId: source.route.id, routeVersion: source.route.version,
    termsVersion: parcel.termsVersion, negotiationId: source.negotiation.id,
    negotiationVersion: source.negotiation.version, approvedAt: source.negotiation.approvedAt,
    ...split,
    agreedAccessTerms: parcel.accessTerms, accessDescription: draft.fields.accessTerms,
    specialConditions: draft.fields.specialConditions, draftVersion: draft.version,
    draftId: draft.id, sourceMode: 'fixture', status: 'draft'};
}

export function escapeContractHTML(value) {
  return String(value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

export function renderContractDocument(draft, input, execution = {}) {
  const d = contractDocument(draft, input), e = escapeContractHTML;
  return `<article class="cg-paper" aria-label="Contract draft preview">
    <div class="cg-paper-top"><span>QUICKGRID / AGREEMENTS</span><span>DRAFT · FICTIONAL DEMO</span></div>
    <h1>${e(d.title)}</h1><p class="cg-paper-subtitle">Transmission corridor &amp; ongoing land use</p>
    <div class="cg-document-meta"><span>Reference <b>${e(d.reference)}</b></span><span>Agreement date <b>${e(d.agreementDate)}</b></span></div>
    <section><h2>01 / Parties &amp; purpose</h2><p>This draft records the approved fictional negotiation between <strong>${e(d.ownerName)}</strong> (landowner) and <strong>${e(d.developerName)}</strong> (developer) for <strong>${e(d.projectName)}</strong>.</p></section>
    <section><h2>02 / Land &amp; approved access</h2><p><strong>${e(d.parcelId)}</strong> — ${e(d.landDescription)}</p><p>Route: ${e(d.routeName)} · version ${d.routeVersion}.</p><p class="cg-preserve">Approved terms: ${e(d.agreedAccessTerms)}</p><p class="cg-preserve">Draft access description: ${e(d.accessDescription)}</p><p class="cg-document-note">Draft descriptions and notes do not amend the approved negotiation. Changed terms require a new approval.</p></section>
    <section><h2>03 / One-time compensation</h2><p>Total agreed compensation is <strong>${money(d.totalCents)}</strong>, divided into the two tranches below.</p><table><thead><tr><th>Milestone</th><th>Amount</th></tr></thead><tbody><tr><td>Contract stage · 20%</td><td>${money(d.initialCents)}</td></tr><tr><td>After recorded completion · remaining balance</td><td>${money(d.completionCents)}</td></tr><tr class="cg-table-total"><td>Total compensation</td><td>${money(d.totalCents)}</td></tr></tbody></table><p class="cg-document-note">Initial payment is rounded down to the nearest cent. The completion balance is the exact remainder. These are payment terms; consult the payment ledger for execution status.</p></section>
    <section><h2>04 / Draft notes</h2><p class="cg-preserve">${e(d.specialConditions || 'No additional draft notes.')}</p></section>
    <section><h2>05 / Simulated click signatures</h2><table><tbody>${[['utility','Power utility'],['landowner','Landowner']].map(([side,label]) => {
      const signature = execution.signatures?.[side];
      return `<tr><td>${label}</td><td>${signature?.simulated === true && timestamp(signature.signedAt) ? `Signed · ${e(signature.signedAt)}` : 'Awaiting click signature'}</td></tr>`;
    }).join('')}</tbody></table></section>
    <footer><p>Source: ${e(d.negotiationId)} v${d.negotiationVersion} · terms v${d.termsVersion} · draft v${d.draftVersion}</p><p>Fictional development agreement. Click signatures are simulated, not legally executed. Saving or downloading never initiates a payment; explicit submission is required.</p></footer>
  </article>`;
}

export function exportContractHTML(draft, input, execution = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>QuickGrid contract draft</title><style>body{margin:0;background:#f0f1ed;padding:32px;color:#26382e;font:15px/1.7 Georgia,serif}.cg-paper{max-width:760px;margin:auto;background:white;padding:50px;box-sizing:border-box}.cg-paper h1{font-size:36px}.cg-paper h2{font:600 12px Arial,sans-serif;letter-spacing:1px;margin-top:30px}.cg-paper-top,.cg-document-meta,.cg-document-note,.cg-paper footer{font:11px/1.7 Arial,sans-serif}.cg-paper-top,.cg-document-meta{display:flex;justify-content:space-between;gap:20px}.cg-document-meta span b{display:block}.cg-paper table{width:100%;border-collapse:collapse}.cg-paper th,.cg-paper td{padding:10px 0;border-bottom:1px solid #ddd;text-align:left}.cg-paper th:last-child,.cg-paper td:last-child{text-align:right}.cg-preserve{white-space:pre-wrap;overflow-wrap:anywhere}.cg-paper footer{border-top:1px solid #ddd;margin-top:30px;padding-top:16px}@media print{body{padding:0;background:white}.cg-paper{max-width:none;padding:15mm}section{break-inside:avoid}}</style></head><body>${renderContractDocument(draft, input, execution)}</body></html>`;
}

export function createContractDraftStore(storage) {
  const key = (source, parcelId) => CONTRACT_STORAGE_PREFIX + encodeURIComponent(`${source.sessionId}|${source.route.id}|${parcelId}`);
  return {
    load(source, parcelId) {
      try {
        const raw = storage?.getItem(key(source, parcelId));
        if (!raw) return {status: 'empty', draft: null};
        const draft = JSON.parse(raw), validation = validateContractDraft(draft, source);
        if (!validation.valid || draft.parcelId !== parcelId) return {status: 'stale', draft: null};
        const clean = createContractDraft(source, parcelId, {id: draft.id, now: draft.createdAt});
        return {status: 'restored', draft: {...clean, version: draft.version, updatedAt: draft.updatedAt,
          fields: Object.fromEntries(DRAFT_FIELDS.map(field => [field, draft.fields[field]]))}};
      } catch { return {status: 'unavailable', draft: null}; }
    },
    save(draft, source) {
      const validation = validateContractDraft(draft, source);
      if (!validation.valid) throw new Error(validation.errors.join(' '));
      if (!storage) throw new Error('Browser storage is unavailable. Download your draft to keep a copy.');
      const clean = createContractDraft(source, draft.parcelId, {id: draft.id, now: draft.createdAt});
      storage.setItem(key(source, draft.parcelId), JSON.stringify({...clean, version: draft.version, updatedAt: draft.updatedAt,
        fields: Object.fromEntries(DRAFT_FIELDS.map(field => [field, draft.fields[field]]))}));
    },
  };
}
