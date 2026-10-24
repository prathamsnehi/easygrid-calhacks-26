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
  if (input.project?.signerName !== undefined && !text(input.project.signerName, 160)) errors.push('The developer representative needs a valid name.');
  if (input.negotiation?.status !== 'approved') errors.push('Negotiation must be approved before starting a contract.');
  if (!validId(input.negotiation?.id) || !version(input.negotiation?.version) || !timestamp(input.negotiation?.approvedAt)) errors.push('The approved negotiation needs an ID, version and approval time.');
  if (!Array.isArray(input.parcels) || input.parcels.length === 0 || input.parcels.length > 100) errors.push('The final route must include between 1 and 100 parcels.');
  else {
    const ids = new Set();
    for (const parcel of input.parcels) {
      if (!parcel || !validId(parcel.parcelId) || ids.has(parcel.parcelId)) errors.push('Each parcel needs a unique parcel ID.');
      ids.add(parcel?.parcelId);
      if (!validId(parcel?.ownerId) || !text(parcel?.ownerName, 160) || !text(parcel?.landDescription, 1000)) errors.push('Each parcel needs a fictional owner and land description.');
      if (parcel?.signerName !== undefined && !text(parcel.signerName, 160)) errors.push('The landowner representative needs a valid name.');
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
    project: {name: input.project.name.trim(), developerName: input.project.developerName.trim(),
      ...(input.project.signerName !== undefined ? {signerName: input.project.signerName.trim()} : {})},
    route: {id: input.route.id, version: input.route.version, name: input.route.name.trim()},
    negotiation: {id: input.negotiation.id, version: input.negotiation.version, status: 'approved', approvedAt: input.negotiation.approvedAt},
    parcels: input.parcels.map(p => ({parcelId: p.parcelId, ownerId: p.ownerId, ownerName: p.ownerName.trim(),
      ...(p.signerName !== undefined ? {signerName: p.signerName.trim()} : {}),
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
    ...(source.project.signerName ? {developerSignerName: source.project.signerName} : {}),
    ...(parcel.signerName ? {ownerSignerName: parcel.signerName} : {}),
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
  const date = value => new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric', timeZone:'UTC'});
  const changedDescription = d.accessDescription.trim() !== d.agreedAccessTerms.trim();
  return `<article class="cg-paper" aria-label="Contract draft preview">
    <div class="cg-paper-top"><span>QUICKGRID / LAND AGREEMENTS</span><span>FICTIONAL SAMPLE · DRAFT ${d.draftVersion}</span></div>
    <h1>Land access agreement</h1><p class="cg-paper-subtitle">${e(d.projectName)}</p>
    <div class="cg-document-meta"><span>PARCEL<b>${e(d.parcelId)}</b></span><span>AGREEMENT DATE<b>${e(date(d.agreementDate))}</b></span><span>APPROVED TERMS<b>Version ${d.termsVersion}</b></span></div>
    <section><h2>01 / The parties</h2><div class="cg-parties"><div><span>Landowner</span><strong>${e(d.ownerName)}</strong></div><div><span>Developer</span><strong>${e(d.developerName)}</strong></div></div></section>
    <section><h2>02 / Land &amp; access</h2><p>${e(d.landDescription)}</p><div class="cg-access-box"><p class="cg-preserve"><strong>Approved terms:</strong> ${e(d.agreedAccessTerms)}</p></div>${changedDescription ? `<p class="cg-preserve"><strong>Draft access description:</strong> ${e(d.accessDescription)}</p><p class="cg-document-note">This proposed description is for review; it does not change the approved access terms.</p>` : ''}</section>
    <section><h2>03 / Compensation &amp; payment schedule</h2><table><thead><tr><th>Payment milestone</th><th>Amount · USD</th></tr></thead><tbody><tr><td>Initial payment · 20%<small>After all final-route agreements are signed</small></td><td>${money(d.initialCents)}</td></tr><tr><td>Completion balance<small>After recorded construction completion</small></td><td>${money(d.completionCents)}</td></tr><tr class="cg-table-total"><td>Total agreed compensation</td><td>${money(d.totalCents)}</td></tr></tbody></table><p class="cg-document-note">The initial payment is rounded down to the nearest cent; the final payment is the exact remainder. Each payment requires a separate action.</p></section>
    ${d.specialConditions.trim() ? `<section><h2>Reviewer notes</h2><p class="cg-preserve">${e(d.specialConditions)}</p><p class="cg-document-note">Notes do not amend the approved negotiation.</p></section>` : ''}
    <section><h2>04 / Signatures</h2><div class="cg-document-signatures">${[['utility','Developer',d.developerName,d.developerSignerName],['landowner','Landowner',d.ownerName,d.ownerSignerName]].map(([side,label,organization,representative]) => {
      const signature = execution.signatures?.[side];
      const signed = signature?.simulated === true && timestamp(signature.signedAt), name = representative || organization;
      return `<div class="cg-signature-block"><span class="cg-signature-role">${label}</span><div class="cg-signature-line">${signed ? `<span class="cg-autograph cg-autograph-${side}" aria-label="Simulated signature by ${e(name)}">${e(name)}</span>` : '<span class="cg-signature-pending">Awaiting click signature</span>'}</div><strong>${e(name)}</strong>${representative ? `<span class="cg-signature-organization">${e(organization)}</span>` : ''}<small>${signed ? `${e(date(signature.signedAt))} · Simulated signature` : 'Signature required'}</small></div>`;
    }).join('')}</div></section>
    <footer><details class="cg-source-details"><summary>Approval reference &amp; versions</summary><p>Reference: ${e(d.reference)}<br>Route: ${e(d.routeName)} · ${e(d.routeId)} v${d.routeVersion}<br>Source: ${e(d.negotiationId)} v${d.negotiationVersion} · terms v${d.termsVersion} · draft v${d.draftVersion}<br>Approved: ${e(d.approvedAt)}</p></details><p>Fictional demo agreement. Signatures and payments are simulated; this is not a legally executed contract.</p></footer>
  </article>`;
}

export function exportContractHTML(draft, input, execution = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>QuickGrid contract draft</title><style>body{margin:0;background:#f0f1ed;padding:32px;color:#26382e;font:15px/1.7 Georgia,serif}.cg-paper{max-width:760px;margin:auto;background:white;padding:50px;box-sizing:border-box}.cg-paper h1{font-size:36px}.cg-paper h2{font:600 12px Arial,sans-serif;letter-spacing:1px;margin-top:30px}.cg-paper-top,.cg-document-meta,.cg-document-note,.cg-paper footer{font:11px/1.7 Arial,sans-serif}.cg-paper-top,.cg-document-meta{display:flex;justify-content:space-between;gap:20px}.cg-document-meta span b{display:block}.cg-paper table{width:100%;border-collapse:collapse}.cg-paper th,.cg-paper td{padding:10px 0;border-bottom:1px solid #ddd;text-align:left}.cg-paper th:last-child,.cg-paper td:last-child{text-align:right}.cg-parties,.cg-document-signatures{display:grid;grid-template-columns:1fr 1fr;gap:24px}.cg-parties span,.cg-document-signatures small{display:block;font:11px/1.6 Arial,sans-serif;color:#7c8c70}.cg-access-box{background:#f3f6ed;padding:12px 16px;border-left:2px solid #91a57d}.cg-document-signatures>div{border-top:1px solid #ccd7bd;padding-top:12px}td small{display:block;font-size:11px;color:#859577}.cg-document-meta{gap:20px}.cg-source-details{margin-bottom:12px}.cg-preserve{white-space:pre-wrap;overflow-wrap:anywhere}.cg-paper footer{border-top:1px solid #ddd;margin-top:30px;padding-top:16px}.cg-document-signatures>div{border-top:0;padding-top:0;min-width:0}.cg-signature-role{display:block;font:600 8px/1.5 Arial,sans-serif;text-transform:uppercase;letter-spacing:1px;color:#7d8f70}.cg-signature-line{min-height:81px;display:flex;align-items:center;position:relative;border-bottom:1px solid #c4ceba;margin:0 0 11px;padding:8px 3px 10px}.cg-autograph{display:inline-block;position:relative;color:#243d60;font:400 35px/1.15 "Snell Roundhand","Apple Chancery","Segoe Script","Brush Script MT",cursive;transform:rotate(-4deg);overflow-wrap:anywhere}.cg-autograph:after{content:"";position:absolute;left:7%;right:-5%;bottom:-3px;height:7px;border-bottom:1px solid currentColor;border-radius:0 0 55% 45%;transform:rotate(-4deg);opacity:.65}.cg-autograph-landowner{transform:rotate(-2deg);font-style:italic}.cg-signature-pending{font:italic 11px/1.5 Georgia,serif;color:#a1aa98}.cg-document-signatures strong{font:600 10px/1.5 Arial,sans-serif;color:#45543d}.cg-signature-organization{display:block;font:9px/1.5 Arial,sans-serif;color:#7e8f71;margin-top:2px}.cg-document-signatures small{font:8px/1.5 Arial,sans-serif;color:#8d9b80;margin-top:7px}@media(max-width:760px){.cg-autograph{font-size:27px}.cg-signature-line{min-height:76px}}@media print{body{padding:0;background:white}.cg-paper{max-width:none;padding:15mm}section{break-inside:avoid}}</style></head><body>${renderContractDocument(draft, input, execution)}</body></html>`;
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
