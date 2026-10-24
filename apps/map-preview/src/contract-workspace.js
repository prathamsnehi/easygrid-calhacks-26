import {validateContractSource, normalizeContractSource, contractSourceKey, compensationSplit, money, createContractDraft, validateContractDraft, updateContractDraft, renderContractDocument, exportContractHTML, createContractDraftStore} from './contract-authoring.js';
import {createContractAPIClient} from './contract-api-client.js';

/** Shared document editor, used by the map host and the explicitly labeled fixture preview. */
export function createContractWorkspace({storage, onClose = () => {}, isCurrent = () => true, api = createContractAPIClient()} = {}) {
  const ids = ['contract-workspace','cg-close','cg-demo-controls','cg-example-status','cg-package-state','cg-gate','cg-gate-title','cg-gate-copy','cg-proceed','cg-gate-error','cg-approved-tag','cg-project-name','cg-route-name','cg-owner-count','cg-total','cg-initial','cg-balance','cg-editor','cg-draft-state','cg-parcel','cg-owner-caption','cg-form','cg-developer','cg-date','cg-access','cg-notes','cg-save','cg-download','cg-feedback','cg-parcel-total','cg-parcel-initial','cg-parcel-balance','cg-preview','cg-version','cg-stale'];
  ids.push('cg-sign-utility','cg-sign-landowner','cg-utility-signature-status','cg-landowner-signature-status','cg-submit','cg-reconcile','cg-reject','cg-execution-status','cg-provider-mode','cg-scenario-wrap','cg-finance-scenario','cg-audit-panel','cg-payment-state','cg-payment-summary','cg-audit-list','cg-journal-summary');
  ids.push('cg-construction-status','cg-pay-balance','cg-balance-status','cg-balance-reconcile','cg-balance-reject','cg-preview-completion');
  const el = Object.fromEntries(ids.map(id => [id, document.querySelector(`#${id}`)]));
  const store = createContractDraftStore(storage), drafts = new Map();
  let source = null, sourceKey = null, selected = null, invalidated = false, restoreFocus = null, previousInert = false, generation = 0, busy = false, demoMode = false;
  let constructionHandler = null, constructionAbort = new AbortController(), notifiedRun = null;
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
    for (const other of drafts.values()) if (other.execution) other.execution.construction = result.construction;
  }
  function notifyConstruction() {
    const construction = entry()?.execution?.construction;
    if (!current() || !constructionHandler || construction?.status !== 'in-progress' || notifiedRun === construction.constructionId) return;
    const signal = constructionAbort.signal, binding = {...construction};
    notifiedRun = construction.constructionId;
    // Handler return/resolution never establishes completion. THEO reports it explicitly.
    try { Promise.resolve(constructionHandler({construction: binding, signal, onComplete: () => signal.aborted ? Promise.reject(new Error('The construction context changed.')) : reportConstructionComplete(binding)})).catch(() => {
      if (!signal.aborted) feedback('The construction animation could not be started. The completion payment remains locked.', true);
    }); } catch { feedback('The construction animation could not be started. The completion payment remains locked.', true); }
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
    const execution = value.execution, payment = execution?.payment;
    const balance = execution?.balancePayment, construction = execution?.construction;
    const valid = current() && validateContractDraft(candidate(), source).valid;
    const locked = Boolean(payment && payment.status !== 'held');
    const both = Boolean(execution?.signatures?.utility && execution?.signatures?.landowner);
    for (const side of ['utility','landowner']) {
      el[`cg-sign-${side}`].disabled = !valid || busy || locked || Boolean(execution?.signatures?.[side]);
      write(`cg-${side}-signature-status`, execution?.signatures?.[side] ? '✓ Signed' : 'Sign ↗');
    }
    el['cg-submit'].disabled = !valid || busy || !both || !execution?.packageReady || locked;
    el['cg-submit'].textContent = payment?.status === 'paid' ? 'Initial 20% paid · simulated' : 'Pay initial 20% · simulated';
    el['cg-reconcile'].hidden = !['submitted','processing','unknown','review-required'].includes(payment?.status);
    el['cg-reconcile'].disabled = busy || !valid;
    el['cg-reject'].hidden = payment?.status !== 'held'; el['cg-reject'].disabled = busy || !valid;
    el['cg-pay-balance'].disabled = !valid || busy || !both || payment?.status !== 'paid' || construction?.status !== 'completed' || Boolean(balance && balance.status !== 'held');
    el['cg-pay-balance'].textContent = balance?.status === 'paid' ? 'Completion balance paid · simulated' : 'Pay completion balance · simulated';
    el['cg-balance-reconcile'].hidden = !['submitted','processing','unknown','review-required'].includes(balance?.status);
    el['cg-balance-reconcile'].disabled = busy || !valid;
    el['cg-balance-reject'].hidden = balance?.status !== 'held'; el['cg-balance-reject'].disabled = busy || !valid;
    el['cg-preview-completion'].hidden = !demoMode || execution?.bankMode !== 'simulation';
    el['cg-preview-completion'].disabled = !valid || busy || construction?.status !== 'in-progress';
    write('cg-construction-status', construction?.status === 'completed' ? (balance?.status === 'paid' ? 'Construction complete. This parcel\'s compensation is fully paid.' : 'Construction complete. The completion balance is ready for payment.') : construction?.status === 'in-progress' ? 'Construction in progress. Waiting for the construction host to report completion.' : `Construction starts after all initial payments are confirmed (${construction?.paidCount ?? 0}/${construction?.parcelCount ?? source.parcels.length}).`);
    write('cg-balance-status', balance ? `${money(balance.amountCents)} · ${balance.reason}` : 'The remaining compensation unlocks after recorded construction completion.');
    for (const id of ['cg-developer','cg-date','cg-access','cg-notes']) el[id].disabled = locked || busy || invalidated;
    el['cg-parcel'].disabled = busy || invalidated;
    el['cg-finance-scenario'].disabled = busy || locked;
    el['cg-scenario-wrap'].hidden = !demoMode || execution?.bankMode === 'nessie-sandbox';
    write('cg-provider-mode', execution ? `${execution.bankMode === 'simulation' ? 'Local simulation' : 'Nessie sandbox'} · rule-based finance worker · simulated role identities` : 'Local development service · click signatures are simulated');
    if (busy) write('cg-execution-status', 'Checking the contract workflow…');
    else if (payment) write('cg-execution-status', `${payment.status === 'paid' ? (execution.bankMode === 'simulation' ? 'Simulated 20% payment complete. ' : 'Sandbox 20% payment confirmed. ') : ''}${payment.reason}`);
    else write('cg-execution-status', both ? (execution?.packageReady ? 'The full package is signed. Pay the initial 20% to fund construction.' : 'Sign every final-route contract before paying any initial amount.') : 'Both signatures are required before payment.');
    el['cg-audit-panel'].hidden = !execution?.audit?.length;
    if (execution?.audit?.length) {
      write('cg-payment-state', balance?.status === 'paid' ? 'Compensation paid' : payment?.status ?? 'Awaiting payment');
      write('cg-payment-summary', payment ? `Initial: ${money(payment.amountCents)} · ${payment.status}. Completion: ${balance ? `${money(balance.amountCents)} · ${balance.status}` : 'awaiting completion'}. All payments are simulated.` : 'The utility approver, landowner and payment worker have distinct simulated identities.');
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
    write('cg-draft-state', value.saved && !dirty(value) ? 'Saved in this browser' : 'Unsaved draft');
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
    write('cg-owner-caption', `${parcel.ownerName} · approved terms v${parcel.termsVersion}`);
    const split = compensationSplit(parcel.compensationCents);
    write('cg-parcel-total', money(split.totalCents)); write('cg-parcel-initial', money(split.initialCents));
    write('cg-parcel-balance', money(split.completionCents));
    feedback(notice); renderDraft();
    perform('state', {saveFirst:false, quiet:true});
  }
  function renderGate(input) {
    const validation = validateContractSource(input), approved = validation.valid;
    const status = approved ? 'Approved negotiation' : input?.negotiation?.status === 'refused' ? 'Negotiation refused' : 'Awaiting approval';
    write('cg-package-state', status); el['cg-package-state'].className = `cg-status${approved ? '' : ' cg-pending'}`;
    write('cg-approved-tag', approved ? 'CONFIRMED' : 'NOT APPROVED');
    write('cg-gate-title', approved ? 'The terms are agreed.\nLet’s prepare the contracts.' : 'An approved negotiation\ncomes first.');
    write('cg-gate-copy', approved ? 'All landowners on the final route have approved their terms. Create individual drafts using those exact amounts.' : 'Contract authoring unlocks when every final-route landowner has accepted complete terms and the negotiation result is approved.');
    write('cg-project-name', input?.project?.name ?? 'Project details pending'); write('cg-route-name', input?.route?.name ?? 'Final route pending');
    const rows = Array.isArray(input?.parcels) ? input.parcels : [];
    write('cg-owner-count', rows.length);
    const totals = rows.reduce((sum, p) => ({total: sum.total + (Number.isSafeInteger(p.compensationCents) ? p.compensationCents : 0), initial: sum.initial + (Number.isSafeInteger(p.compensationCents) && p.compensationCents >= 0 ? compensationSplit(p.compensationCents).initialCents : 0)}), {total: 0, initial: 0});
    write('cg-total', approved ? money(totals.total) : '—'); write('cg-initial', approved ? money(totals.initial) : '—');
    write('cg-balance', approved ? money(totals.total - totals.initial) : '—');
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
    if (!validateContractDraft(candidate(), source).valid) return;
    if (saveFirst) {
      try {
        if (dirty(value)) { value.draft = updateContractDraft(value.draft, value.fields, source); value.fields = {...value.draft.fields}; value.execution = null; }
        store.save(value.draft, source); value.saved = true;
      } catch { feedback('Browser storage is unavailable; the server will still validate this contract.', true); }
    }
    const ticket = ++generation; busy = true; renderDraft();
    try {
      const result = await api(operation, candidate(), {...(operation === 'submit' ? {scenario:el['cg-finance-scenario'].value || 'normal'} : {}), ...extra});
      if (ticket !== generation || !current() || entry() !== value) return;
      applyExecution(value, result);
      return result;
    } catch (error) {
      if (ticket !== generation) return;
      if (!quiet) feedback(error.message, true);
      if (operation === 'construction-complete') throw error;
    } finally {
      if (ticket === generation) { busy = false; renderDraft(); notifyConstruction(); }
    }
  }
  el['cg-proceed'].addEventListener('click', () => {
    if (!current()) { invalidate(); return; }
    el['cg-parcel'].replaceChildren(...source.parcels.map(parcel => {
      const option = document.createElement('option'); option.value = parcel.parcelId; option.textContent = `${parcel.ownerName} / ${parcel.parcelId}`; return option;
    }));
    el['cg-gate'].hidden = true; el['cg-editor'].hidden = false;
    chooseParcel(selected ?? source.parcels[0].parcelId); el['cg-developer'].focus({preventScroll: true});
  });
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
      const link = document.createElement('a'); link.href = url; link.download = `QuickGrid-${draft.parcelId}-draft-v${draft.version}.html`;
      document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      feedback('Current draft downloaded. Open it in a browser to print or save as PDF.');
    } catch { feedback('Complete the required fields before downloading.', true); }
  });
  el['cg-close'].addEventListener('click', close);
  for (const side of ['utility','landowner']) el[`cg-sign-${side}`].addEventListener('click', () => perform(`sign/${side}`));
  el['cg-submit'].addEventListener('click', () => perform('submit'));
  el['cg-reconcile'].addEventListener('click', () => perform('reconcile'));
  el['cg-reject'].addEventListener('click', () => perform('reject'));
  el['cg-pay-balance'].addEventListener('click', () => perform('submit', {extra: {stage: 'balance'}}));
  el['cg-balance-reconcile'].addEventListener('click', () => perform('reconcile', {extra: {stage: 'balance'}}));
  el['cg-balance-reject'].addEventListener('click', () => perform('reject', {extra: {stage: 'balance'}}));
  el['cg-preview-completion'].addEventListener('click', () => reportConstructionComplete(entry()?.execution?.construction).catch(error => feedback(error.message, true)));
  el['contract-workspace'].addEventListener('keydown', event => {
    if (event.key === 'Escape' && !el['cg-close'].hidden) { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key !== 'Tab') return;
    const nodes = [...el['contract-workspace'].querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]')].filter(node => node.getClientRects().length > 0);
    const first = nodes[0], last = nodes.at(-1);
    if (nodes.length && ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last))) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
  });
  return {open, close, setSource, invalidate, setConstructionHandler, reportConstructionComplete};
}
