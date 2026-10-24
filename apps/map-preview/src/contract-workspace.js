import {validateContractSource, normalizeContractSource, contractSourceKey, compensationPayment, money, createContractDraft, validateContractDraft, updateContractDraft, renderContractDocument, exportContractHTML, createContractDraftStore} from './contract-authoring.js';
import {createContractAPIClient} from './contract-api-client.js';

/** Shared document editor, used by the map host and the explicitly labeled fixture preview. */
export function createContractWorkspace({storage, onClose = () => {}, isCurrent = () => true, api = createContractAPIClient()} = {}) {
  const ids = ['contract-workspace','cg-close','cg-demo-controls','cg-example-status','cg-package-state','cg-gate','cg-gate-title','cg-gate-copy','cg-proceed','cg-gate-error','cg-approved-tag','cg-project-name','cg-route-name','cg-owner-count','cg-total','cg-editor','cg-draft-state','cg-parcel','cg-owner-caption','cg-form','cg-developer','cg-date','cg-access','cg-notes','cg-save','cg-download','cg-feedback','cg-parcel-total','cg-preview','cg-version','cg-stale'];
  ids.push('cg-sign-utility','cg-sign-landowner','cg-utility-signature-status','cg-landowner-signature-status','cg-submit','cg-reconcile','cg-reject','cg-execution-status','cg-provider-mode','cg-scenario-wrap','cg-finance-scenario','cg-audit-panel','cg-payment-state','cg-payment-summary','cg-audit-list','cg-journal-summary');
  ids.push('cg-payment-panel','cg-signer-developer','cg-signer-owner');
  ids.push('cg-demo-provider','cg-payout-provider','cg-payout-recipient','cg-payout-basis','cg-payout-status','cg-payout-help','cg-transfer-reference','cg-transfer-reference-value','cg-footer-disclaimer');
  const el = Object.fromEntries(ids.map(id => [id, document.querySelector(`#${id}`)]));
  const store = createContractDraftStore(storage), drafts = new Map();
  let source = null, sourceKey = null, selected = null, invalidated = false, restoreFocus = null, previousInert = false, generation = 0, busy = false, demoMode = false;
  let constructionHandler = null, constructionAbort = new AbortController(), notifiedRun = null;
  let paymentAction = null;
  const write = (id, value) => { el[id].textContent = String(value); };
  const fields = () => ({developerName: el['cg-developer'].value, agreementDate: el['cg-date'].value, accessTerms: el['cg-access'].value, specialConditions: el['cg-notes'].value});
  const entry = () => drafts.get(selected);
  const dirty = value => JSON.stringify(value.fields) !== JSON.stringify(value.draft.fields);
  function feedback(message = '', error = false) { write('cg-feedback', message); el['cg-feedback'].className = `cg-feedback${error ? ' cg-error' : ''}`; }
  function current() { return !invalidated && source && validateContractSource(source).valid && isCurrent(); }
  function candidate() {
    const value = entry();
    return {...value.draft, version: value.draft.version + (dirty(value) ? 1 : 0), fields: {...value.fields}};
  }
  function resetConstructionHost() { constructionAbort.abort(); constructionAbort = new AbortController(); notifiedRun = null; }
  function applyExecution(value, result) {
    value.execution = result;
    value.submissionUnconfirmed = false;
    for (const other of drafts.values()) if (other.execution) other.execution.construction = result.construction;
  }
  function notifyConstruction() {
    const construction = entry()?.execution?.construction;
    if (!current() || !constructionHandler || construction?.status !== 'in-progress' || notifiedRun === construction.constructionId) return;
    const signal = constructionAbort.signal, binding = {...construction};
    notifiedRun = construction.constructionId;
    // Handler return/resolution never establishes completion. THEO reports it explicitly.
    try { Promise.resolve(constructionHandler({construction: binding, signal, onComplete: () => signal.aborted ? Promise.reject(new Error('The construction context changed.')) : reportConstructionComplete(binding)})).catch(() => {
      if (!signal.aborted) feedback('The construction animation could not be started.', true);
    }); } catch { feedback('The construction animation could not be started.', true); }
  }
  function setConstructionHandler(handler) {
    if (handler !== null && typeof handler !== 'function') throw new Error('Construction handler must be a function or null.');
    if (handler === constructionHandler) return;
    resetConstructionHost(); constructionHandler = handler; notifyConstruction();
  }
  async function reportConstructionComplete(binding) {
    if (!current() || !entry()) throw new Error('The current construction context is unavailable.');
    const construction = entry().execution?.construction;
    if (!construction || !['constructionId','packageHash','sessionId','routeId','routeVersion'].every(key => binding?.[key] === construction[key])) throw new Error('Completion does not match the current construction run.');
    return perform('construction-complete', {extra: {completion: {...binding, eventId: `completed-${binding.constructionId}`}}});
  }
  function renderExecution() {
    const value = entry(); if (!value) return;
    const execution = value.execution;
    const owner = source.parcels.find(p => p.parcelId === selected);
    const amount = compensationPayment(owner.compensationCents);
    const payment = value.submissionUnconfirmed ? {status:'unknown', amountCents:amount.paymentCents,
      reason:'The payment response was not received. Check transfer status before sending again.'} : execution?.payment;
    const valid = current() && validateContractDraft(candidate(), source).valid;
    const locked = Boolean(payment && payment.status !== 'held');
    const both = Boolean(execution?.signatures?.utility && execution?.signatures?.landowner);
    const nessie = execution?.bankMode === 'nessie-sandbox';
    const provider = nessie ? 'Nessie sandbox' : execution?.bankMode === 'simulation' ? 'Local simulation' : 'Bank connection pending';
    const paymentsEnabled = execution?.paymentsEnabled !== false;
    el['cg-payment-panel'].hidden = !both && !payment;
    write('cg-demo-provider', nessie ? 'Nessie sandbox' : 'Simulation');
    write('cg-payout-provider', provider);
    write('cg-payout-recipient', `To ${owner.ownerName}`);
    write('cg-payout-basis', `100% of ${money(amount.totalCents)} approved compensation`);
    write('cg-signer-developer', source.project.signerName ? `${source.project.signerName} · ${value.fields.developerName}` : value.fields.developerName);
    write('cg-signer-owner', owner.signerName || owner.ownerName);
    for (const side of ['utility','landowner']) {
      el[`cg-sign-${side}`].disabled = !valid || busy || locked || Boolean(execution?.signatures?.[side]);
      write(`cg-${side}-signature-status`, execution?.signatures?.[side] ? '✓ Signed' : 'Sign ↗');
    }
    el['cg-submit'].disabled = !valid || busy || !both || !execution?.packageReady || locked || !paymentsEnabled;
    el['cg-submit'].textContent = busy && paymentAction === 'full' ? 'Sending payment…' : `${payment?.status === 'paid' ? 'Paid in full' : 'Pay full amount'} · ${money(amount.paymentCents)}`;
    const paymentLabels = {checking:'Checking payment',processing:'Processing',submitted:'Pending confirmation',unknown:'Outcome unknown','review-required':'Needs review',held:'On hold',rejected:'Rejected',paid:'Paid'};
    write('cg-payout-status', busy && paymentAction === 'full' ? 'Submitting once' : paymentLabels[payment?.status] ?? (!execution?.packageReady ? 'Waiting for all signatures' : !paymentsEnabled ? 'Setup required' : 'Ready to send'));
    el['cg-payout-status'].className = `cg-payment-chip${payment?.status === 'paid' ? ' cg-payment-chip-success' : ['held','unknown','review-required','rejected'].includes(payment?.status) ? ' cg-payment-chip-attention' : ''}`;
    write('cg-payout-help', payment ? payment.reason : !execution?.packageReady ? 'Sign every agreement on this route before sending the full payment.' : !paymentsEnabled ? 'Nessie sandbox transfers are not enabled on the server yet.' : nessie ? 'This sends a sandbox transfer. No real money moves.' : 'This records a local simulated transfer. No real money moves.');
    el['cg-transfer-reference'].hidden = !payment?.transactionRef;
    write('cg-transfer-reference-value', payment?.transactionRef ?? '');
    el['cg-reconcile'].hidden = !['submitted','processing','unknown','review-required'].includes(payment?.status);
    el['cg-reconcile'].disabled = busy || !valid;
    el['cg-reject'].hidden = payment?.status !== 'held'; el['cg-reject'].disabled = busy || !valid;
    for (const id of ['cg-developer','cg-date','cg-access','cg-notes']) el[id].disabled = locked || busy || invalidated;
    el['cg-parcel'].disabled = busy || invalidated;
    el['cg-finance-scenario'].disabled = busy || locked;
    el['cg-scenario-wrap'].hidden = !demoMode || execution?.bankMode === 'nessie-sandbox';
    write('cg-provider-mode', execution ? `${provider} · rule-based finance worker · simulated role identities` : 'Local development service · click signatures are simulated');
    write('cg-footer-disclaimer', nessie ? 'Fictional demo · simulated signatures · Nessie sandbox payments' : 'Fictional demo · simulated signatures and payments');
    if (busy) write('cg-execution-status', 'Checking the contract workflow…');
    else if (payment) write('cg-execution-status', `${payment.status === 'paid' ? (execution.bankMode === 'simulation' ? 'Simulated full payment complete. ' : 'Sandbox full payment confirmed. ') : ''}${payment.reason}`);
    else write('cg-execution-status', both ? (execution?.packageReady ? paymentsEnabled ? 'The full package is signed. The full amount is ready for payment.' : 'The full package is signed. Sandbox transfers are not enabled yet.' : 'Sign every final-route contract before making the full payment.') : 'Both signatures are required before payment.');
    el['cg-audit-panel'].hidden = !execution?.audit?.length;
    if (execution?.audit?.length) {
      write('cg-payment-state', payment?.status === 'paid' ? 'Paid in full' : payment?.status ?? 'Awaiting payment');
      el['cg-payment-state'].className = `cg-status${payment?.status === 'paid' ? '' : ' cg-pending'}`;
      write('cg-payment-summary', payment ? `Full payment: ${money(payment.amountCents)} · ${payment.status}. ${provider}; no real money moves.` : 'The utility approver, landowner and payment worker have distinct simulated identities.');
      el['cg-audit-list'].replaceChildren(...execution.audit.map(event => {
        const item = document.createElement('li'), title = document.createElement('strong'), detail = document.createElement('span');
        title.textContent = event.action.replaceAll('-', ' '); detail.textContent = `${event.reason} (${event.actorId})`;
        item.appendChild(title); item.appendChild(detail); return item;
      }));
      const journal = execution.journal ?? [];
      write('cg-journal-summary', journal.length ? `Balanced demo journal: ${journal.length} entries · debit ${money(journal.reduce((sum, row) => sum + row.debitCents, 0))} / credit ${money(journal.reduce((sum, row) => sum + row.creditCents, 0))}.` : 'No completed-payment journal entry has been posted.');
    }
  }
  function renderDraft() {
    if (!entry()) return;
    const value = entry(), draft = candidate(), validation = validateContractDraft(draft, source);
    const valid = validation.valid && current();
    el['cg-save'].disabled = !valid; el['cg-download'].disabled = !valid;
    for (const [field, id] of [['developerName','cg-developer'],['agreementDate','cg-date'],['accessTerms','cg-access']]) {
      el[id].setAttribute('aria-invalid', String(!value.fields[field]?.trim()));
    }
    write('cg-draft-state', value.saved && !dirty(value) ? 'Draft saved' : 'Draft ready for review');
    el['cg-draft-state'].className = `cg-draft-status${value.saved && !dirty(value) ? ' cg-saved' : ''}`;
    if (validation.valid) { el['cg-preview'].innerHTML = renderContractDocument(draft, source, value.execution ?? {}); write('cg-version', `DRAFT / V${draft.version}`); }
    if (!validation.valid) feedback(validation.errors.join(' '), true);
    renderExecution();
  }
  function chooseParcel(parcelId) {
    if (!current()) return;
    generation++; busy = false;
    selected = parcelId;
    const parcel = source.parcels.find(p => p.parcelId === selected);
    if (!parcel) return;
    let notice = '';
    if (!drafts.has(selected)) {
      const result = store.load(source, selected);
      const draft = result.draft ?? createContractDraft(source, selected);
      drafts.set(selected, {draft, fields: {...draft.fields}, saved: Boolean(result.draft), execution: null});
      if (result.status === 'restored') notice = 'Your saved draft was restored from this browser.';
      if (result.status === 'stale') notice = 'The previous draft used older terms. A new draft was created.';
      if (result.status === 'unavailable') notice = 'Browser storage could not be read. You can still download a draft.';
    }
    const value = entry(); el['cg-parcel'].value = selected;
    for (const [field, id] of [['developerName','cg-developer'],['agreementDate','cg-date'],['accessTerms','cg-access'],['specialConditions','cg-notes']]) el[id].value = value.fields[field];
    write('cg-owner-caption', `Approved terms · version ${parcel.termsVersion}`);
    write('cg-parcel-total', money(parcel.compensationCents));
    feedback(notice); renderDraft();
    perform('state', {saveFirst:false, quiet:true});
  }
  function renderGate(input) {
    const validation = validateContractSource(input), approved = validation.valid;
    const status = approved ? 'Approved terms' : input?.negotiation?.status === 'refused' ? 'Negotiation refused' : 'Awaiting approval';
    write('cg-package-state', status); el['cg-package-state'].className = `cg-status${approved ? '' : ' cg-pending'}`;
    write('cg-approved-tag', approved ? 'CONFIRMED' : 'NOT APPROVED');
    write('cg-gate-title', approved ? 'Your agreements are ready to prepare.' : 'Waiting for approved terms.');
    write('cg-gate-copy', approved ? 'The final route, landowners and compensation are confirmed. Review each agreement, then collect both signatures.' : 'Contract authoring unlocks when every final-route landowner has accepted complete terms and the negotiation result is approved.');
    write('cg-project-name', input?.project?.name ?? 'Project details pending'); write('cg-route-name', input?.route?.name ?? 'Final route pending');
    const rows = Array.isArray(input?.parcels) ? input.parcels : [];
    write('cg-owner-count', rows.length);
    const total = rows.reduce((sum, p) => sum + (Number.isSafeInteger(p.compensationCents) ? p.compensationCents : 0), 0);
    write('cg-total', approved ? money(total) : '—');
    el['cg-proceed'].disabled = !approved; write('cg-gate-error', approved ? '' : validation.errors[0]);
  }
  function setSource(input) {
    const validation = validateContractSource(input), nextKey = validation.valid ? contractSourceKey(input) : null;
    if (nextKey && nextKey === sourceKey && !invalidated) return;
    resetConstructionHost();
    source = validation.valid ? normalizeContractSource(input) : null; sourceKey = nextKey; selected = null; invalidated = false; drafts.clear(); generation++; busy = false;
    el['cg-gate'].hidden = false; el['cg-editor'].hidden = true; el['cg-stale'].hidden = true;
    for (const id of ['cg-developer','cg-date','cg-access','cg-notes','cg-parcel']) el[id].disabled = false;
    renderGate(input); feedback();
  }
  function open(input, {demo = false, simulationControls = false} = {}) {
    demoMode = demo || simulationControls;
    setSource(input);
    restoreFocus = document.activeElement;
    const background = document.querySelector('#demo-workspace');
    if (el['contract-workspace'].hidden && background) { previousInert = background.inert; background.inert = true; }
    el['contract-workspace'].hidden = false; el['cg-demo-controls'].hidden = !demo; el['cg-close'].hidden = demo;
    el['contract-workspace'].setAttribute('aria-modal', String(!demo));
    (demo ? el['cg-example-status'] : el['cg-close']).focus({preventScroll: true});
  }
  function close() {
    el['contract-workspace'].hidden = true;
    const background = document.querySelector('#demo-workspace'); if (background) background.inert = previousInert;
    restoreFocus?.focus?.({preventScroll: true}); onClose();
  }
  function invalidate() {
    resetConstructionHost();
    generation++; busy = false;
    invalidated = true; el['cg-proceed'].disabled = true; el['cg-save'].disabled = true; el['cg-download'].disabled = true;
    for (const id of ['cg-developer','cg-date','cg-access','cg-notes','cg-parcel']) el[id].disabled = true;
    el['cg-stale'].hidden = false; write('cg-package-state', 'Approval changed'); feedback('The source approval changed. This draft is locked.', true);
    if (entry()) renderExecution();
  }
  async function perform(operation, {saveFirst = true, quiet = false, extra = {}} = {}) {
    if ((busy && operation !== 'construction-complete') || !current() || !entry()) return;
    const value = entry();
    if (operation === 'submit' && (value.submissionUnconfirmed || value.execution?.payment && value.execution.payment.status !== 'held')) return;
    if (!validateContractDraft(candidate(), source).valid) return;
    if (saveFirst) {
      try {
        if (dirty(value)) { value.draft = updateContractDraft(value.draft, value.fields, source); value.fields = {...value.draft.fields}; value.execution = null; }
        store.save(value.draft, source); value.saved = true;
      } catch { feedback('Browser storage is unavailable; the server will still validate this contract.', true); }
    }
    const ticket = ++generation; busy = true; paymentAction = operation === 'submit' ? extra.stage ?? 'full' : null; renderDraft();
    try {
      const requestDraft = candidate();
      const recoveringSubmission = operation === 'reconcile' && value.submissionUnconfirmed;
      let result;
      if (recoveringSubmission) {
        // A lost HTTP response cannot establish whether the server attempted a transfer.
        // Recover the recorded obligation before asking the bank to reconcile it.
        result = await api('state', requestDraft);
        if (ticket !== generation || !current() || entry() !== value) return;
        if (['submitted','processing','unknown','review-required'].includes(result.payment?.status)) result = await api('reconcile', requestDraft, extra);
      } else result = await api(operation, requestDraft, {...(operation === 'submit' ? {scenario:el['cg-finance-scenario'].value || 'normal'} : {}), ...extra});
      if (ticket !== generation || !current() || entry() !== value) return;
      applyExecution(value, result);
      if (recoveringSubmission) feedback();
      return result;
    } catch (error) {
      if (ticket !== generation) return;
      if (operation === 'submit') value.submissionUnconfirmed = true;
      if (!quiet) feedback(error.message, true);
      if (operation === 'construction-complete') throw error;
    } finally {
      if (ticket === generation) { busy = false; paymentAction = null; renderDraft(); notifyConstruction(); }
    }
  }
  function review() {
    if (!current()) { invalidate(); return; }
    el['cg-parcel'].replaceChildren(...source.parcels.map(parcel => {
      const option = document.createElement('option'); option.value = parcel.parcelId; option.textContent = `${parcel.ownerName} / ${parcel.parcelId}`; return option;
    }));
    el['cg-gate'].hidden = true; el['cg-editor'].hidden = false;
    chooseParcel(selected ?? source.parcels[0].parcelId); el['cg-parcel'].focus({preventScroll: true});
  }
  el['cg-proceed'].addEventListener('click', review);
  el['cg-parcel'].addEventListener('change', () => chooseParcel(el['cg-parcel'].value));
  for (const id of ['cg-developer','cg-date','cg-access','cg-notes']) el[id].addEventListener('input', () => {
    if (!current()) { invalidate(); return; }
    generation++; busy = false; entry().fields = fields(); entry().execution = null; feedback(); renderDraft();
  });
  el['cg-form'].addEventListener('submit', event => {
    event.preventDefault(); if (!current()) { invalidate(); return; }
    try {
      const value = entry(), next = dirty(value) ? updateContractDraft(value.draft, value.fields, source) : value.draft;
      store.save(next, source); value.draft = next; value.fields = {...next.fields}; value.saved = true;
      renderDraft(); feedback('Draft saved in this browser. No contract was signed and no payment was made.');
    } catch { feedback('The draft could not be saved. Check required fields or download a copy if browser storage is unavailable.', true); }
  });
  el['cg-download'].addEventListener('click', () => {
    if (!current()) { invalidate(); return; }
    try {
      const draft = candidate(), html = exportContractHTML(draft, source, entry().execution ?? {});
      const url = URL.createObjectURL(new Blob([html], {type: 'text/html;charset=utf-8'}));
      const link = document.createElement('a'); link.href = url; link.download = `EasyGrid-${draft.parcelId}-draft-v${draft.version}.html`;
      document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      feedback('Current draft downloaded. Open it in a browser to print or save as PDF.');
    } catch { feedback('Complete the required fields before downloading.', true); }
  });
  el['cg-close'].addEventListener('click', close);
  for (const side of ['utility','landowner']) el[`cg-sign-${side}`].addEventListener('click', () => perform(`sign/${side}`));
  el['cg-submit'].addEventListener('click', () => perform('submit', {extra: {stage: 'full'}}));
  el['cg-reconcile'].addEventListener('click', () => perform('reconcile', {extra: {stage: 'full'}}));
  el['cg-reject'].addEventListener('click', () => perform('reject', {extra: {stage: 'full'}}));
  el['contract-workspace'].addEventListener('keydown', event => {
    if (event.key === 'Escape' && !el['cg-close'].hidden) { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key !== 'Tab') return;
    const nodes = [...el['contract-workspace'].querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary')].filter(node => node.getClientRects().length > 0);
    const first = nodes[0], last = nodes.at(-1);
    if (nodes.length && ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last))) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
  });
  return {open, close, review, setSource, invalidate, setConstructionHandler, reportConstructionComplete};
}
