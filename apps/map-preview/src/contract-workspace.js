import {validateContractSource, normalizeContractSource, contractSourceKey, compensationPayment, money, createContractDraft, validateContractDraft, updateContractDraft, renderContractDocument, exportContractHTML, createContractDraftStore} from './contract-authoring.js';
import {createContractAPIClient} from './contract-api-client.js';

/** Shared document editor, used by the map host and the explicitly labeled fixture preview. */
export function createContractWorkspace({storage, onClose = () => {}, isCurrent = () => true, api = createContractAPIClient()} = {}) {
  const ids = ['contract-workspace','cg-close','cg-demo-controls','cg-example-status','cg-package-state','cg-gate','cg-gate-title','cg-gate-copy','cg-proceed','cg-gate-error','cg-approved-tag','cg-project-name','cg-route-name','cg-owner-count','cg-total','cg-editor','cg-draft-state','cg-parcel','cg-owner-caption','cg-form','cg-developer','cg-date','cg-access','cg-notes','cg-save','cg-download','cg-feedback','cg-parcel-total','cg-preview','cg-version','cg-stale'];
  ids.push('cg-sign-utility','cg-sign-landowner','cg-utility-signature-status','cg-landowner-signature-status','cg-submit','cg-reconcile','cg-reject','cg-execution-status','cg-provider-mode','cg-scenario-wrap','cg-finance-scenario','cg-audit-panel','cg-payment-state','cg-payment-summary','cg-audit-list','cg-journal-summary');
  ids.push('cg-payment-panel','cg-signer-developer','cg-signer-owner');
  ids.push('cg-demo-provider','cg-payout-title','cg-payout-provider','cg-payout-recipient','cg-payout-basis','cg-payout-status','cg-payout-help','cg-transfer-reference','cg-transfer-reference-value','cg-transfer-reference-label','cg-footer-disclaimer');
  ids.push('cg-title','cg-page-eyebrow','cg-page-description','cg-step-agreement','cg-step-agreement-number','cg-step-payment','cg-selection-bar','cg-agreement-preview','cg-agreement-sidebar','cg-continue-payment','cg-payment-view','cg-back-agreement','cg-payment-agreement','cg-payment-owner','cg-payment-amount','cg-payment-parcel','cg-remaining-panel','cg-agreement-progress','cg-review-remaining');
  ids.push('cg-owner-count-label','cg-payment-signatures','cg-gate-scope-label','cg-gate-payment-help','cg-signing-timing','cg-payment-timing');
  const el = Object.fromEntries(ids.map(id => [id, document.querySelector(`#${id}`)]));
  const store = createContractDraftStore(storage), drafts = new Map();
  let source = null, sourceKey = null, selected = null, invalidated = false, restoreFocus = null, previousInert = false, generation = 0, busy = false, demoMode = false;
  let constructionHandler = null, constructionAbort = new AbortController(), notifiedRun = null;
  let paymentAction = null, activeView = 'agreement', demoParcelId = null;
  const write = (id, value) => { el[id].textContent = String(value); };
  const fields = () => ({developerName: el['cg-developer'].value, agreementDate: el['cg-date'].value, accessTerms: el['cg-access'].value, specialConditions: el['cg-notes'].value});
  const entry = () => drafts.get(selected);
  const isRecordOnly = execution => execution?.paymentSemantics === 'record-only';
  const recordNotice = 'This creates a Nessie transaction record. No account balances move.';
  const amountIssue = (execution, amountCents) => isRecordOnly(execution) && amountCents % (execution.amountIncrementCents ?? 100) !== 0
    ? `Nessie supports whole-dollar records only. The approved ${money(amountCents)} is unchanged and will not be rounded.` : '';

  const dirty = value => JSON.stringify(value.fields) !== JSON.stringify(value.draft.fields);
  function feedback(message = '', error = false) { write('cg-feedback', message); el['cg-feedback'].className = `cg-feedback cg-workspace-feedback${error ? ' cg-error' : ''}`; }
  function current() { return !invalidated && source && validateContractSource(source).valid && isCurrent(); }
  function candidate() {
    const value = entry();
    return {...value.draft, version: value.draft.version + (dirty(value) ? 1 : 0), fields: {...value.fields}};
  }
  const documentExecution = value => ({...(value.execution ?? {}),...(demoParcelId ? {demoScope:'single-owner',demoParcelId} : {})});
  const visibleParcels = () => source?.parcels.filter(parcel => !demoParcelId || parcel.parcelId === demoParcelId) ?? [];
  const paymentReady = execution => demoParcelId ? execution?.demoScope === 'single-owner' && execution.demoParcelId === demoParcelId && execution.paymentReady === true : execution?.packageReady === true;
  function renderView() {
    const paymentView = activeView === 'payment' && !el['cg-editor'].hidden;
    el['cg-payment-view'].hidden = !paymentView;
    el['cg-payment-panel'].hidden = !paymentView;
    for (const id of ['cg-selection-bar','cg-agreement-preview','cg-agreement-sidebar']) el[id].hidden = paymentView;
    el['cg-selection-bar'].hidden = paymentView || Boolean(demoParcelId);
    write('cg-title', paymentView ? 'Review your payment.' : 'Review your agreement.');
    write('cg-page-eyebrow', demoParcelId ? (paymentView ? 'SINGLE-LANDOWNER DEMO / PAYMENT' : 'SINGLE-LANDOWNER DEMO / AGREEMENT') : paymentView ? 'LAND ACCESS / PAYMENT' : 'LAND ACCESS / AGREEMENTS');
    write('cg-page-description', paymentView ? (isRecordOnly(entry()?.execution) ? 'Review the full amount and register a Nessie record. No account balances move.' : 'Review the full amount and confirm one payment.') : demoParcelId ? 'One representative landowner agreement for this demo.' : 'Confirmed terms, ready for your review and signatures.');
    el['cg-step-agreement'].className = paymentView ? 'cg-flow-done' : 'cg-flow-active';
    el['cg-step-payment'].className = paymentView ? 'cg-flow-active' : '';
    el['cg-step-agreement'].setAttribute('aria-current', paymentView ? 'false' : 'step');
    el['cg-step-payment'].setAttribute('aria-current', paymentView ? 'step' : 'false');
    write('cg-step-agreement-number', paymentView ? '✓' : '2');
    el['cg-back-agreement'].disabled = busy;
  }
  function openPayment() {
    const value = entry();
    if (!current() || busy || !value || !validateContractDraft(candidate(), source).valid || !value.execution?.signatures?.utility || !value.execution?.signatures?.landowner) return;
    activeView = 'payment'; renderExecution(); el['contract-workspace'].scrollTop = 0; el['cg-title'].focus({preventScroll: true});
  }
  function backToAgreement() {
    if (busy) return;
    activeView = 'agreement'; renderView(); el['cg-continue-payment'].focus({preventScroll: true});
  }
  function resetConstructionHost() { constructionAbort.abort(); constructionAbort = new AbortController(); notifiedRun = null; }
  function applyExecution(value, result, {recoverUnconfirmed = false} = {}) {
    value.execution = result;
    if (!value.submissionUnconfirmed || recoverUnconfirmed) value.submissionUnconfirmed = false;
    for (const other of drafts.values()) if (other.execution) other.execution.construction = result.construction;
  }
  function notifyConstruction() {
    const construction = entry()?.execution?.construction;
    if (!current() || isRecordOnly(entry()?.execution) || !constructionHandler || construction?.status !== 'in-progress' || notifiedRun === construction.constructionId) return;
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
    const execution = value.execution, recordOnly = isRecordOnly(execution);
    const owner = source.parcels.find(p => p.parcelId === selected);
    const amount = compensationPayment(owner.compensationCents), unsupportedAmount = amountIssue(execution, amount.paymentCents);
    const existingPayment = recordOnly && execution?.payment?.status === 'paid' ? {...execution.payment,status:'review-required',reason:'This earlier payment status needs review. A Nessie record does not establish payment to the landowner.'} : execution?.payment;
    const payment = value.submissionUnconfirmed ? {status:'unknown', amountCents:amount.paymentCents,
      reason:recordOnly ? 'The registration response was not received. Check record status before trying again.' : 'The payment response was not received. Check transfer status before sending again.'} : existingPayment;
    const valid = current() && validateContractDraft(candidate(), source).valid;
    const locked = Boolean(payment && payment.status !== 'held');
    const both = Boolean(execution?.signatures?.utility && execution?.signatures?.landowner);
    const nessie = execution?.bankMode === 'nessie-sandbox';
    const provider = nessie ? 'Nessie sandbox' : execution?.bankMode === 'simulation' ? 'Local simulation' : 'Bank connection pending';
    const paymentsEnabled = execution?.paymentsEnabled !== false;
    el['cg-continue-payment'].disabled = !valid || busy || !both;
    write('cg-signing-timing', demoParcelId ? 'After both parties sign this agreement' : 'After all route agreements are signed');
    write('cg-payment-timing', demoParcelId ? 'After both parties sign this agreement' : 'After all route agreements are signed');
    write('cg-payment-owner', owner.ownerName);
    write('cg-payment-amount', money(amount.paymentCents));
    write('cg-payment-parcel', owner.parcelId);
    write('cg-payment-agreement', `Agreement ${owner.parcelId} · draft v${candidate().version}`);
    const progress = execution?.agreementProgress;
    write('cg-payment-signatures', both ? 'Both parties signed' : 'Signatures required');
    el['cg-remaining-panel'].hidden = Boolean(demoParcelId) || paymentReady(execution) || !progress?.nextUnsignedParcelId;
    write('cg-agreement-progress', `${progress?.signedCount ?? 0} of ${progress?.totalCount ?? source.parcels.length} agreements signed`);
    el['cg-review-remaining'].disabled = busy || !valid || !progress?.nextUnsignedParcelId;
    renderView();
    write('cg-demo-provider', nessie ? 'Nessie sandbox' : 'Simulation');
    write('cg-payout-title', recordOnly ? 'Transaction record · 100%' : 'Full payment · 100%');
    write('cg-payout-provider', provider);
    write('cg-payout-recipient', `${recordOnly ? 'Agreement for' : 'To'} ${owner.ownerName}`);
    write('cg-payout-basis', `100% of ${money(amount.totalCents)} approved compensation`);
    write('cg-signer-developer', source.project.signerName ? `${source.project.signerName} · ${value.fields.developerName}` : value.fields.developerName);
    write('cg-signer-owner', owner.signerName || owner.ownerName);
    for (const side of ['utility','landowner']) {
      el[`cg-sign-${side}`].disabled = !valid || busy || locked || Boolean(execution?.signatures?.[side]);
      write(`cg-${side}-signature-status`, execution?.signatures?.[side] ? '✓ Signed' : 'Sign ↗');
    }
    el['cg-submit'].hidden = busy && paymentAction === null;
    el['cg-submit'].disabled = !valid || busy || !both || !paymentReady(execution) || locked || !paymentsEnabled || Boolean(unsupportedAmount);
    el['cg-submit'].textContent = busy && paymentAction === 'full' ? (recordOnly ? 'Registering amount…' : 'Sending payment…') : `${payment?.status === 'recorded' ? 'Recorded in Nessie' : payment?.status === 'paid' ? 'Paid in full' : recordOnly ? 'Register full amount' : 'Pay full amount'} · ${money(amount.paymentCents)}`;
    const paymentLabels = {checking:'Checking payment',processing:'Processing',submitted:'Pending confirmation',unknown:'Outcome unknown','review-required':'Needs review',held:'On hold',rejected:'Rejected',paid:'Paid',recorded:'Recorded in Nessie'};
    write('cg-payout-status', busy && paymentAction === 'full' ? 'Submitting once' : paymentLabels[payment?.status] ?? (!paymentReady(execution) ? 'Waiting for all signatures' : !paymentsEnabled ? 'Setup required' : unsupportedAmount ? 'Whole-dollar amount required' : recordOnly ? 'Ready to register' : 'Ready to send'));
    el['cg-payout-status'].className = `cg-payment-chip${['paid','recorded'].includes(payment?.status) ? ' cg-payment-chip-success' : ['held','unknown','review-required','rejected'].includes(payment?.status) ? ' cg-payment-chip-attention' : ''}`;
    const setupMessage = recordOnly ? 'Nessie sandbox record creation is not enabled on the server yet.' : 'Nessie sandbox transfers are not enabled on the server yet.';
    const signatureMessage = demoParcelId ? 'Both parties must sign this example agreement before the final action.' : recordOnly ? 'Sign every agreement on this route before registering the full amount.' : 'Sign every agreement on this route before sending the full payment.';
    const paymentHelp = payment ? payment.status === 'recorded' ? recordNotice : `${payment.reason}${recordOnly ? ` ${recordNotice}` : ''}` : unsupportedAmount || (!paymentReady(execution) ? signatureMessage : !paymentsEnabled ? setupMessage : recordOnly ? recordNotice : nessie ? 'This sends a sandbox transfer. No real money moves.' : 'This records a local simulated transfer. No real money moves.');
    write('cg-payout-help', paymentHelp);
    write('cg-transfer-reference-label', recordOnly ? 'Record reference' : 'Transfer reference');
    write('cg-reconcile', recordOnly ? 'Check record status' : 'Check transfer status');
    write('cg-reject', recordOnly ? 'Reject record request' : 'Reject payment');
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
    write('cg-footer-disclaimer', recordOnly ? 'Fictional demo · Nessie transaction records · no account balances move' : nessie ? 'Fictional demo · simulated signatures · Nessie sandbox payments' : 'Fictional demo · simulated signatures and payments');
    if (busy) write('cg-execution-status', 'Checking the contract workflow…');
    else if (payment?.status === 'recorded') write('cg-execution-status', 'Recorded in Nessie. No account balances move; the landowner has not been paid.');
    else if (recordOnly) write('cg-execution-status', paymentHelp);
    else if (demoParcelId && !payment) write('cg-execution-status', both ? 'Both parties signed this example agreement. Continue to review the full amount.' : 'Both parties must sign this example agreement.');
    else if (payment) write('cg-execution-status', `${payment.status === 'paid' ? (execution.bankMode === 'simulation' ? 'Simulated full payment complete. ' : 'Sandbox full payment confirmed. ') : ''}${payment.reason}`);
    else write('cg-execution-status', both ? (paymentReady(execution) ? paymentsEnabled ? 'The full package is signed. The full amount is ready for payment.' : 'The full package is signed. Sandbox transfers are not enabled yet.' : 'Sign every final-route contract before making the full payment.') : 'Both signatures are required before payment.');
    el['cg-audit-panel'].hidden = !execution?.audit?.length;
    if (execution?.audit?.length) {
      write('cg-payment-state', payment?.status === 'recorded' ? 'Recorded in Nessie' : payment?.status === 'paid' ? 'Paid in full' : payment?.status ?? 'Awaiting payment');
      el['cg-payment-state'].className = `cg-status${['paid','recorded'].includes(payment?.status) ? '' : ' cg-pending'}`;
      write('cg-payment-summary', payment ? recordOnly ? `Nessie record: ${money(payment.amountCents)} · ${paymentLabels[payment.status] ?? payment.status}. No account balances move.` : `Full payment: ${money(payment.amountCents)} · ${payment.status}. ${provider}; no real money moves.` : 'The utility approver, landowner and payment worker have distinct simulated identities.');
      el['cg-audit-list'].replaceChildren(...execution.audit.map(event => {
        const item = document.createElement('li'), title = document.createElement('strong'), detail = document.createElement('span');
        title.textContent = event.action.replaceAll('-', ' '); detail.textContent = `${event.reason} (${event.actorId})`;
        item.appendChild(title); item.appendChild(detail); return item;
      }));
      const journal = execution.journal ?? [];
      write('cg-journal-summary', recordOnly ? 'Nessie records do not move account balances or create a payment journal.' : journal.length ? `Balanced demo journal: ${journal.length} entries · debit ${money(journal.reduce((sum, row) => sum + row.debitCents, 0))} / credit ${money(journal.reduce((sum, row) => sum + row.creditCents, 0))}.` : 'No completed-payment journal entry has been posted.');
    }
  }
  function renderDraft() {
    if (!entry()) return;
    const value = entry(), draft = candidate(), validation = validateContractDraft(draft, source);
    const valid = validation.valid && current();
    el['cg-save'].disabled = !valid || busy; el['cg-download'].disabled = !valid || busy;
    for (const [field, id] of [['developerName','cg-developer'],['agreementDate','cg-date'],['accessTerms','cg-access']]) {
      el[id].setAttribute('aria-invalid', String(!value.fields[field]?.trim()));
    }
    write('cg-draft-state', value.saved && !dirty(value) ? 'Draft saved' : 'Draft ready for review');
    el['cg-draft-state'].className = `cg-draft-status${value.saved && !dirty(value) ? ' cg-saved' : ''}`;
    if (validation.valid) { el['cg-preview'].innerHTML = renderContractDocument(draft, source, documentExecution(value)); write('cg-version', `DRAFT / V${draft.version}`); }
    if (!validation.valid) feedback(validation.errors.join(' '), true);
    renderExecution();
  }
  function chooseParcel(parcelId) {
    if (!current() || busy || !visibleParcels().some(parcel => parcel.parcelId === parcelId)) return;
    generation++; busy = false; activeView = 'agreement';
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
    write('cg-gate-title', approved ? (demoParcelId ? 'Your example agreement is ready.' : 'Your agreements are ready to prepare.') : 'Waiting for approved terms.');
    write('cg-gate-copy', approved ? (demoParcelId ? 'Review one representative landowner’s approved terms, sign both parties, then open payment.' : 'The final route, landowners and compensation are confirmed. Review each agreement, then collect both signatures.') : 'Contract authoring unlocks when every final-route landowner has accepted complete terms and the negotiation result is approved.');
    write('cg-project-name', input?.project?.name ?? 'Project details pending'); write('cg-route-name', input?.route?.name ?? 'Final route pending');
    const rows = Array.isArray(input?.parcels) ? input.parcels.filter(parcel => !demoParcelId || parcel.parcelId === demoParcelId) : [];
    write('cg-proceed', demoParcelId ? 'Review agreement →' : 'Review agreements →');
    write('cg-gate-scope-label', demoParcelId ? 'SINGLE-LANDOWNER DEMO' : 'ALL LANDOWNERS');
    write('cg-gate-payment-help', demoParcelId ? 'One full payment after both parties sign this example agreement.' : 'Full payment to each landowner after every agreement is signed.');
    write('cg-owner-count', rows.length);
    write('cg-owner-count-label', demoParcelId ? 'example landowner' : 'landowner agreements');
    const total = rows.reduce((sum, p) => sum + (Number.isSafeInteger(p.compensationCents) ? p.compensationCents : 0), 0);
    write('cg-total', approved ? money(total) : '—');
    el['cg-proceed'].disabled = !approved; write('cg-gate-error', approved ? '' : validation.errors[0]);
  }
  function setSource(input) {
    const validation = validateContractSource(input), nextKey = validation.valid ? contractSourceKey(input) : null;
    if (nextKey && nextKey === sourceKey && !invalidated) return;
    resetConstructionHost();
    source = validation.valid ? normalizeContractSource(input) : null; sourceKey = nextKey; selected = null; invalidated = false; drafts.clear(); generation++; busy = false;
    el['cg-gate'].hidden = false; el['cg-editor'].hidden = true; el['cg-stale'].hidden = true; activeView = 'agreement'; renderView();
    for (const id of ['cg-developer','cg-date','cg-access','cg-notes','cg-parcel']) el[id].disabled = false;
    renderGate(input); feedback();
  }
  function open(input, {demo = false, simulationControls = false, demoParcelId:requestedParcelId = null} = {}) {
    if (requestedParcelId !== null && !input?.parcels?.some(parcel => parcel.parcelId === requestedParcelId)) throw new Error('The representative demo landowner is not on this approved route.');
    if (demoParcelId !== requestedParcelId) { demoParcelId = requestedParcelId; sourceKey = null; }
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
    if (operation === 'submit') {
      const execution = value.execution;
      if (activeView !== 'payment' || !execution?.signatures?.utility || !execution?.signatures?.landowner || !paymentReady(execution) || execution.paymentsEnabled === false) return;
      const issue = amountIssue(execution, source.parcels.find(parcel => parcel.parcelId === selected).compensationCents);
      if (issue) { feedback(issue, true); return; }
    }
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
      applyExecution(value, result, {recoverUnconfirmed:recoveringSubmission});
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
    el['cg-parcel'].replaceChildren(...visibleParcels().map(parcel => {
      const option = document.createElement('option'); option.value = parcel.parcelId; option.textContent = `${parcel.ownerName} / ${parcel.parcelId}`; return option;
    }));
    el['cg-gate'].hidden = true; el['cg-editor'].hidden = false;
    chooseParcel(selected ?? visibleParcels()[0].parcelId); (demoParcelId ? el['cg-title'] : el['cg-parcel']).focus({preventScroll: true});
  }
  el['cg-proceed'].addEventListener('click', review);
  el['cg-continue-payment'].addEventListener('click', openPayment);
  el['cg-back-agreement'].addEventListener('click', backToAgreement);
  el['cg-review-remaining'].addEventListener('click', () => {
    const nextParcel = entry()?.execution?.agreementProgress?.nextUnsignedParcelId;
    if (busy || !current() || !nextParcel || !source.parcels.some(parcel => parcel.parcelId === nextParcel)) return;
    chooseParcel(nextParcel); el['cg-sign-utility'].focus({preventScroll: true});
  });
  el['cg-parcel'].addEventListener('change', () => chooseParcel(el['cg-parcel'].value));
  for (const id of ['cg-developer','cg-date','cg-access','cg-notes']) el[id].addEventListener('input', () => {
    if (busy) return;
    if (!current()) { invalidate(); return; }
    generation++; busy = false; entry().fields = fields(); entry().execution = null; feedback(); renderDraft();
  });
  el['cg-form'].addEventListener('submit', event => {
    event.preventDefault(); if (busy) return; if (!current()) { invalidate(); return; }
    try {
      const value = entry(), next = dirty(value) ? updateContractDraft(value.draft, value.fields, source) : value.draft;
      store.save(next, source); value.draft = next; value.fields = {...next.fields}; value.saved = true;
      renderDraft(); feedback('Draft saved in this browser. No contract was signed and no payment was made.');
    } catch { feedback('The draft could not be saved. Check required fields or download a copy if browser storage is unavailable.', true); }
  });
  el['cg-download'].addEventListener('click', () => {
    if (!current()) { invalidate(); return; }
    try {
      const draft = candidate(), html = exportContractHTML(draft, source, documentExecution(entry()));
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
