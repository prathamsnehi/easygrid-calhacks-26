import {createHash} from 'node:crypto';
import {normalizeContractSource, contractSourceKey, validateContractDraft, contractDocument} from '../src/contract-authoring.js';

const copy = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const DEMO_ACTORS = Object.freeze({
  utility: {id: 'demo-utility-controller', role: 'utility-approver'},
  landowner: {id: 'demo-landowner', role: 'landowner-signer'},
  requester: {id: 'demo-accounts-payable-agent', role: 'payment-requester'},
  construction: {id: 'demo-construction-host', role: 'construction-reporter'},
});
export function contractContentHash(draft, source) {
  return digest({document: contractDocument(draft, source), source: contractSourceKey(source)});
}
export function createWorkflowState() { return {schemaVersion: 1, documents: {}, obligations: {}, audit: [], journal: []}; }

/** Event-driven AP worker. Rules, actor capabilities and evidence control execution, not browser state. */
export function createContractWorkflow({source, bank, initialState = createWorkflowState(), persist = async () => {}, now = () => new Date().toISOString()}) {
  const approvedSource = normalizeContractSource(source), state = copy(initialState);
  const sourceHash = digest(contractSourceKey(approvedSource));
  if (state.schemaVersion !== 1 || !state.documents || !state.obligations || !Array.isArray(state.audit) || !Array.isArray(state.journal)) throw new Error('Invalid development ledger.');
  if (state.construction && (state.construction.sessionId !== approvedSource.sessionId || state.construction.routeId !== approvedSource.route.id || state.construction.routeVersion !== approvedSource.route.version)) throw new Error('The construction ledger belongs to another session or route version.');
  let queue = Promise.resolve();
  const serial = action => {
    const result = queue.then(action); queue = result.catch(() => {}); return result;
  };
  const save = () => persist(copy(state));
  const obligationId = (draft, stage = 'initial') => `${stage}-${digest([approvedSource.sessionId, draft.parcelId]).slice(0, 32)}`;
  const record = (actor, action, reason, draft, evidence = {}) => state.audit.push({sequence: state.audit.length + 1, at: now(), actorId: actor.id, role: actor.role, action, reason,
    draftId: draft.id, parcelId: draft.parcelId, negotiationId: approvedSource.negotiation.id, routeVersion: approvedSource.route.version, ...evidence});
  function authorize(actor, role) { if (!actor?.id || actor.role !== role) throw new Error('This role cannot perform that action.'); }
  function register(draft) {
    const validation = validateContractDraft(draft, approvedSource);
    if (!validation.valid) throw new Error(validation.errors.join(' '));
    const hash = contractContentHash(draft, approvedSource), existing = state.documents[draft.id];
    const submitted = state.obligations[obligationId(draft)];
    if (submitted && submitted.status !== 'held' && submitted.documentHash !== hash) throw new Error('A submitted obligation locks this parcel to its approved document. Reconcile before changing terms.');
    if (existing && existing.hash !== hash && existing.version >= draft.version) throw new Error('A stale or conflicting draft revision cannot replace the current document.');
    for (const other of Object.values(state.documents)) {
      if (other.parcelId === draft.parcelId && other.id !== draft.id && other.hash !== hash) other.signatures = {};
    }
    if (!existing || existing.hash !== hash) state.documents[draft.id] = {id: draft.id, parcelId: draft.parcelId, hash, version: draft.version, signatures: {}};
    // Older ledger entries become eligible only after their draft is checked against this source.
    state.documents[draft.id].sourceHash = sourceHash;
    return state.documents[draft.id];
  }
  function constructionState() {
    const initial = approvedSource.parcels.map(parcel => state.obligations[obligationId(parcel)]);
    return state.construction ? copy(state.construction) : {status: 'awaiting-initial-payments', paidCount: initial.filter(payment => payment?.status === 'paid').length, parcelCount: initial.length};
  }
  function packageReady() {
    return approvedSource.parcels.every(parcel => Object.values(state.documents).some(doc => doc.parcelId === parcel.parcelId && doc.sourceHash === sourceHash &&
      doc.signatures.utility?.documentHash === doc.hash && doc.signatures.landowner?.documentHash === doc.hash &&
      (!state.obligations[obligationId(parcel)] || state.obligations[obligationId(parcel)].documentHash === doc.hash)));
  }
  function startConstruction(draft, actor) {
    if (state.construction) return;
    const initial = approvedSource.parcels.map(parcel => state.obligations[obligationId(parcel)]);
    if (!initial.every(payment => payment?.status === 'paid')) return;
    const packageHash = digest({source: contractSourceKey(approvedSource), documents: initial.map(payment => payment.documentHash)});
    state.construction = {constructionId: `construction-${packageHash.slice(0, 32)}`, packageHash,
      sessionId: approvedSource.sessionId, routeId: approvedSource.route.id, routeVersion: approvedSource.route.version,
      status: 'in-progress', startedAt: now(), completedAt: null, completionEventId: null,
      paidCount: initial.length, parcelCount: initial.length};
    record(actor, 'construction-started', 'All current initial payments are confirmed. Construction may begin.', draft, {constructionId: state.construction.constructionId});
  }
  function paymentView(payment, hash) {
    return payment ? {obligationId: payment.id, amountCents: payment.amountCents, status: payment.status, reason: payment.reason,
      mode: bank.mode, transactionRef: payment.transactionRef ?? null, documentMatches: payment.documentHash === hash} : null;
  }
  function project(draft) {
    const doc = state.documents[draft.id], hash = contractContentHash(draft, approvedSource), payment = state.obligations[obligationId(draft)];
    return {documentHash: hash, draftId: draft.id, signatures: doc?.hash === hash ? copy(doc.signatures) : {},
      payment: paymentView(payment, hash), balancePayment: paymentView(state.obligations[obligationId(draft, 'balance')], hash),
      construction: constructionState(),
      packageReady: packageReady(),
      bankMode: bank.mode, agentMode: 'rule-based-event-worker',
      audit: copy(state.audit.filter(row => row.parcelId === draft.parcelId)),
      journal: copy(state.journal.filter(row => [obligationId(draft), obligationId(draft, 'balance')].includes(row.obligationId)))};
  }
  function reconcileEvidence(payment, evidence, draft, actor) {
    const matches = evidence && evidence.amountCents === payment.amountCents && evidence.obligationId === payment.id && evidence.recipientMatches === true && typeof evidence.transactionRef === 'string' && evidence.transactionRef.length > 0;
    if (!matches) {
      payment.status = 'review-required'; payment.reason = 'Bank evidence does not match the approved obligation. No replacement payment is allowed.';
      record(actor, 'reconciliation-held', payment.reason, draft, {obligationId: payment.id, expectedCents: payment.amountCents, observedCents: evidence?.amountCents ?? null}); return;
    }
    payment.transactionRef = evidence.transactionRef;
    if (evidence.status !== 'completed') {
      payment.status = 'submitted'; payment.reason = 'The sandbox accepted the transfer; completion is not yet confirmed.';
      record(actor, 'bank-submission-pending', payment.reason, draft, {obligationId: payment.id}); return;
    }
    payment.status = 'paid'; payment.reason = 'Approved contract, bank transaction and ledger amount match.';
    if (!state.journal.some(row => row.obligationId === payment.id)) {
      state.journal.push({obligationId: payment.id, stage: payment.stage ?? 'initial', at: now(), debitAccount: payment.stage === 'balance' ? 'demo-land-use-balance' : 'demo-land-use-advance', creditAccount: 'demo-cash', debitCents: payment.amountCents, creditCents: payment.amountCents, documentHash: payment.documentHash});
    }
    record(actor, 'payment-reconciled', payment.reason, draft, {obligationId: payment.id, amountCents: payment.amountCents, journalBalanced: true});
    startConstruction(draft, actor);
  }
  return {
    mode: bank.mode,
    snapshot: () => copy(state),
    inspect: draft => serial(async () => { register(draft); startConstruction(draft, DEMO_ACTORS.requester); await save(); return project(draft); }),
    sign: (draft, side, actor) => serial(async () => {
      if (!['utility', 'landowner'].includes(side)) throw new Error('Unknown signature role.');
      authorize(actor, side === 'utility' ? 'utility-approver' : 'landowner-signer');
      if (actor.id === DEMO_ACTORS.requester.id) throw new Error('The payment requester cannot approve a payment.');
      const doc = register(draft), payment = state.obligations[obligationId(draft)];
      if (payment && !['held'].includes(payment.status)) throw new Error('This obligation already has a payment outcome. Reconcile it before changing the contract.');
      if (doc.signatures[side]) return project(draft);
      if (Object.values(doc.signatures).some(signature => signature.actorId === actor.id)) throw new Error('Utility and landowner signatures require distinct identities.');
      const document = contractDocument(draft, approvedSource);
      doc.signatures[side] = {side, actorId: actor.id, role: actor.role, signedAt: now(), documentHash: doc.hash, simulated: true,
        approvedInitialCents: side === 'utility' ? document.initialCents : null,
        approvedBalanceCents: side === 'utility' ? document.completionCents : null,
        approvedRecipientBinding: side === 'utility' ? bank.recipientBinding(document.ownerId) : null};
      record(actor, `signature-${side}`, side === 'utility' ? 'Utility controller approved this exact document and its initial and completion obligations.' : 'Landowner confirmed this exact fictional contract.', draft, {documentHash: doc.hash});
      await save(); return project(draft);
    }),
    submit: (draft, actor, {scenario = 'normal', stage = 'initial'} = {}) => serial(async () => {
      authorize(actor, 'payment-requester');
      if (!['initial','balance'].includes(stage)) throw new Error('Only initial and completion-balance payments are supported.');
      const doc = register(draft), document = contractDocument(draft, approvedSource), id = obligationId(draft, stage);
      const utility = doc.signatures.utility, landowner = doc.signatures.landowner;
      if (!utility || !landowner || utility.documentHash !== doc.hash || landowner.documentHash !== doc.hash) throw new Error('Both current click signatures are required before submission.');
      if (!packageReady()) throw new Error('Every final-route contract requires current utility approval and landowner signatures before payment.');
      if (utility.actorId === actor.id || landowner.actorId === actor.id || utility.actorId === landowner.actorId) throw new Error('Payment request, utility approval and landowner consent must use distinct identities.');
      const amountCents = stage === 'initial' ? document.initialCents : document.completionCents;
      if ((stage === 'initial' ? utility.approvedInitialCents : utility.approvedBalanceCents) !== amountCents) throw new Error('The requested amount is not covered by utility approval.');
      if (stage === 'balance' && (state.construction?.status !== 'completed' || state.obligations[obligationId(draft)]?.status !== 'paid')) throw new Error('Confirmed initial payments and construction completion are required before paying the balance.');
      let payment = state.obligations[id];
      if (payment && payment.documentHash !== doc.hash && payment.status !== 'held') throw new Error('This parcel already has a different contract payment. A new draft cannot create another obligation.');
      if (payment && !['held'].includes(payment.status)) return project(draft);
      payment = state.obligations[id] = {id, stage, documentHash: doc.hash, amountCents, parcelId: draft.parcelId,
        status: 'checking', requestedBy: actor.id, approvedBy: utility.actorId, reason: 'Validating approved contract against banking evidence.'};
      record(actor, 'payment-requested', stage === 'initial' ? 'Explicit initial-payment request for the approved 20%.' : 'Explicit completion-payment request for the exact approved remainder.', draft, {obligationId: id, amountCents: payment.amountCents, documentHash: doc.hash});
      if (utility.approvedRecipientBinding !== bank.recipientBinding(document.ownerId)) {
        payment.status = 'held'; payment.reason = 'The configured payout destination changed after utility approval.';
        record(actor, 'payment-held', payment.reason, draft, {obligationId:id, rule:'approved-recipient-binding'}); await save(); return project(draft);
      }
      let inspection;
      try { inspection = await bank.inspect({ownerId: document.ownerId, obligationId: id, amountCents: payment.amountCents, documentHash: doc.hash, scenario}); }
      catch { payment.status = 'held'; payment.reason = 'Bank information is unavailable. No transfer was attempted.'; record(actor, 'bank-check-held', payment.reason, draft); await save(); return project(draft); }
      if (inspection.recipientMatches && inspection.existingEvidence) {
        reconcileEvidence(payment, inspection.existingEvidence, draft, actor); await save(); return project(draft);
      }
      if (!inspection.recipientMatches || !Number.isSafeInteger(inspection.balanceCents) || inspection.balanceCents < payment.amountCents) {
        payment.status = 'held'; payment.reason = !inspection.recipientMatches ? 'The payout destination changed after approval. Controller review is required.' : 'Available balance does not cover the approved payment.';
        record(actor, 'payment-held', payment.reason, draft, {obligationId: id, rule: !inspection.recipientMatches ? 'approved-recipient-binding' : 'sufficient-balance'}); await save(); return project(draft);
      }
      if (bank.canTransfer === false) {
        payment.status = 'held'; payment.reason = 'Nessie sandbox writes are disabled. No transfer was attempted.';
        record(actor, 'payment-held', payment.reason, draft); await save(); return project(draft);
      }
      payment.status = 'processing'; payment.reason = 'A single bank submission is authorized.';
      record(actor, 'payment-authorized', 'Distinct utility approval, both signatures, approved recipient and available balance verified.', draft, {obligationId: id});
      // Persist before the external side effect. A crash leaves processing/unknown, never a blind retry.
      await save();
      try {
        const evidence = await bank.transfer({ownerId: document.ownerId, obligationId: id, amountCents: payment.amountCents, documentHash: doc.hash});
        reconcileEvidence(payment, evidence, draft, actor);
      } catch {
        payment.status = 'unknown'; payment.reason = 'The bank outcome is uncertain. Reconcile before any retry.';
        record(actor, 'payment-outcome-unknown', payment.reason, draft, {obligationId: id});
      }
      await save(); return project(draft);
    }),
    completeConstruction: (draft, completion, actor) => serial(async () => {
      authorize(actor, 'construction-reporter'); register(draft);
      const construction = state.construction;
      if (!construction || !['constructionId','packageHash','sessionId','routeId','routeVersion'].every(key => completion?.[key] === construction[key])) throw new Error('Completion must match the current construction run and approved route package.');
      if (!approvedSource.parcels.every(parcel => state.obligations[obligationId(parcel)]?.status === 'paid')) throw new Error('All initial payments must be confirmed before construction completion.');
      if (typeof completion.eventId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(completion.eventId)) throw new Error('A stable construction completion event ID is required.');
      if (construction.status === 'completed') return project(draft);
      construction.status = 'completed'; construction.completedAt = now(); construction.completionEventId = completion.eventId;
      record(actor, 'construction-completed', 'The construction host reported completion for the current run. The balance is now available for explicit payment.', draft, {constructionId: construction.constructionId, eventId: completion.eventId});
      await save(); return project(draft);
    }),
    reconcile: (draft, actor, {stage = 'initial'} = {}) => serial(async () => {
      authorize(actor, 'payment-requester'); register(draft);
      if (!['initial','balance'].includes(stage)) throw new Error('Unknown payment stage.');
      const payment = state.obligations[obligationId(draft, stage)];
      if (!payment || payment.documentHash !== contractContentHash(draft, approvedSource)) throw new Error('No current payment obligation can be reconciled.');
      if (['paid','rejected','held'].includes(payment.status)) return project(draft);
      try {
        const inspection = await bank.inspect({ownerId: contractDocument(draft, approvedSource).ownerId, obligationId: payment.id, amountCents: payment.amountCents, documentHash: payment.documentHash, scenario: 'normal'});
        if (inspection.existingEvidence) reconcileEvidence(payment, inspection.existingEvidence, draft, actor);
        else { payment.status = 'unknown'; payment.reason = 'No matching bank evidence was found. No replacement transfer was sent.'; record(actor, 'reconciliation-unresolved', payment.reason, draft); }
      } catch { payment.status = 'unknown'; payment.reason = 'Bank evidence is unavailable. No replacement transfer was sent.'; }
      await save(); return project(draft);
    }),
    reject: (draft, actor, {stage = 'initial'} = {}) => serial(async () => {
      authorize(actor, 'utility-approver'); register(draft);
      if (!['initial','balance'].includes(stage)) throw new Error('Unknown payment stage.');
      const payment = state.obligations[obligationId(draft, stage)];
      if (!payment || payment.status !== 'held' || actor.id === payment.requestedBy) throw new Error('Only an independent controller may reject a held, unattempted payment.');
      payment.status = 'rejected'; payment.reason = 'The utility controller rejected this payment request.';
      record(actor, 'payment-rejected', payment.reason, draft); await save(); return project(draft);
    }),
  };
}

export function createDemoBank({balanceCents = 10000000} = {}) {
  const transactions = new Map(); let available = balanceCents;
  return {
    mode: 'simulation',
    canTransfer: true,
    recipientBinding: ownerId => digest(['demo-recipient', ownerId]),
    inspect: async ({obligationId, amountCents, scenario = 'normal'}) => ({
      recipientMatches: scenario !== 'recipient-changed', balanceCents: scenario === 'insufficient-funds' ? 0 : available,
      existingEvidence: scenario === 'bank-mismatch' ? {obligationId, amountCents: amountCents - 100, recipientMatches: true, status: 'completed', transactionRef: 'planted-mismatch'} : transactions.get(obligationId) ?? null,
    }),
    transfer: async ({obligationId, amountCents}) => {
      if (transactions.has(obligationId)) return transactions.get(obligationId);
      if (available < amountCents) throw new Error('Insufficient simulated funds.');
      available -= amountCents;
      const evidence = {obligationId, amountCents, recipientMatches: true, status: 'completed', transactionRef: `simulated-${obligationId}`};
      transactions.set(obligationId, evidence); return evidence;
    },
  };
}
