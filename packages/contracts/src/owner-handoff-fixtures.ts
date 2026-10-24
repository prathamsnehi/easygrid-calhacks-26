import {
  OwnerHandoff, assertAgreementReady, createVoiceHandoff, createSettlementPlan,
  settlementObligationId, splitCompensation, type CurrentHandoffState, type SettlementContext,
} from './owner-handoff.ts';

type Packet = ReturnType<typeof OwnerHandoff.parse>;
type Current = CurrentHandoffState;
type Stage = SettlementContext['stage'];
const clone = <T>(value: T): T => structuredClone(value);

/** Invented records in an isolated two-parcel sample world; never real dialing or bank instructions. */
export function createInitialOwnerHandoff(): Packet {
  const row = (parcelId: string, ownerId: string, x: number, compensationCents: number,
    monthlyRentCents: number, offerCapCents: number, towerCount: number, wireLengthMeters: number) => ({
    parcelId, ownerId, landUse: 'Fictional farmland',
    geometry: { type: 'Polygon', coordinates: [[
      [x, 37], [x + 0.005, 37], [x + 0.005, 37.005], [x, 37.005], [x, 37],
    ]] }, areaSqM: 100000,
    impact: { towerCount, wireLengthMeters }, offerCapCents,
    terms: { termsVersion: 1, outcome: 'pending', accessConsent: 'unknown',
      explicitConfirmation: false, confirmationRef: null, compensationCents,
      monthlyRentCents, comparisonRentTotalCents: monthlyRentCents * 2, monthlyRentIsApproximate: false },
  });
  const owner = (ownerId: string, alias: string, index: number) => ({
    ownerId, alias, synthetic: true,
    contact: { contactRef: index === 1 ? 'fixture-user-contact-o001' : null,
      registration: index === 1 ? 'unregistered' : 'simulation', callConsent: false },
    banking: { ownerId, paymentRecipientRef: `mock-recipient-o00${index}`, mode: 'simulated',
      accountHolderAlias: alias, bankDisplay: 'Demo Bank — simulated', accountDisplay: `****100${index}` },
  });
  return OwnerHandoff.parse({
    schemaVersion: 1, kind: 'easygrid-owner-handoff', sourceMode: 'fixture',
    sessionId: 'demo-example-001', projectId: 'project-example-001', routeId: 'route-demo-001',
    routeVersion: 1, revision: 0, referenceBinding: 'local-fixture', currency: 'USD',
    routeStatus: 'selected_for_negotiation', rentHorizonMonths: 2,
    constructionCents: 10000000, budgetCents: 15000000, simulationChecksPassed: true,
    owners: [owner('O001', 'Morgan Reed', 1), owner('O002', 'Dana Brooks', 2)],
    parcels: [row('L001', 'O001', -120.5, 1000000, 30000, 1500000, 2, 400),
      row('L002', 'O002', -120.495, 800000, 20000, 1000000, 1, 300)],
    userRole: { ownerId: 'O001', parcelId: 'L001' },
  });
}

/** Canonical-looking IDs/consent are synthetic examples of host registration, not provider evidence. */
export function createAcceptedOwnerHandoff(): Packet {
  const packet = createInitialOwnerHandoff();
  packet.referenceBinding = 'canonical';
  packet.revision = 3;
  packet.routeStatus = 'ready_for_agreements';
  packet.owners[0]!.contact = {
    contactRef: 'registered-fixture-contact-o001', registration: 'registered', callConsent: true,
  };
  for (const parcel of packet.parcels) {
    parcel.terms.outcome = 'accepted';
    parcel.terms.accessConsent = 'allowed';
    parcel.terms.explicitConfirmation = true;
    parcel.terms.confirmationRef = `fixture-confirmation-${parcel.ownerId}`;
  }
  packet.parcels[0]!.terms.termsVersion = 2;
  packet.parcels[0]!.terms.compensationCents = 1200000;
  return OwnerHandoff.parse(packet);
}

export function createOwnerHandoffCurrent(packet: Packet): Current {
  return {
    sessionId: packet.sessionId, projectId: packet.projectId, routeId: packet.routeId,
    routeVersion: packet.routeVersion, revision: packet.revision,
    termsVersions: Object.fromEntries(packet.parcels.map(p => [p.parcelId, p.terms.termsVersion])),
  };
}

export function createOwnerSettlementContext(packet = createAcceptedOwnerHandoff(),
  stage: Stage = 'contract_tranche'): SettlementContext {
  const recipients = new Map(packet.owners.map(owner => [owner.ownerId, owner.banking.paymentRecipientRef]));
  const paidStage = (stage: 'contract_tranche' | 'completion_balance') => packet.parcels.map(p => ({
    obligationId: settlementObligationId(packet.sessionId, p.parcelId, stage),
    sessionId: packet.sessionId, projectId: packet.projectId, routeId: packet.routeId, routeVersion: packet.routeVersion,
    parcelId: p.parcelId, ownerId: p.ownerId, paymentRecipientRef: recipients.get(p.ownerId)!,
    termsVersion: p.terms.termsVersion, compensationCents: p.terms.compensationCents, monthlyRentCents: p.terms.monthlyRentCents,
    rentHorizonMonths: packet.rentHorizonMonths, completionId: stage === 'contract_tranche' ? null : 'completion-example-001',
    completedOn: stage === 'contract_tranche' ? null : '2026-11-01',
    amountCents: stage === 'contract_tranche' ? splitCompensation(p.terms.compensationCents).contractTrancheCents
      : splitCompensation(p.terms.compensationCents).completionBalanceCents,
  }));
  const first = paidStage('contract_tranche'), balances = paidStage('completion_balance');
  return {
    current: createOwnerHandoffCurrent(packet), approvalId: 'approval-example-001', approved: true,
    approvedPackage: { sessionId: packet.sessionId, projectId: packet.projectId, routeId: packet.routeId,
      routeVersion: packet.routeVersion, termsVersions: createOwnerHandoffCurrent(packet).termsVersions,
      contractVersions: Object.fromEntries(packet.parcels.map(p => [`contract-${p.ownerId.toLowerCase()}`, 1])),
    },
    contracts: packet.parcels.map(p => ({ parcelId: p.parcelId, ownerId: p.ownerId,
      sessionId: packet.sessionId, projectId: packet.projectId, routeId: packet.routeId, routeVersion: packet.routeVersion,
      contractId: `contract-${p.ownerId.toLowerCase()}`, contractVersion: 1,
      termsVersion: p.terms.termsVersion, demoSigned: true,
      compensationCents: p.terms.compensationCents, monthlyRentCents: p.terms.monthlyRentCents, rentHorizonMonths: packet.rentHorizonMonths,
      paymentRecipientRef: recipients.get(p.ownerId)!,
    })),
    stage, asOfDate: stage === 'contract_tranche' ? '2026-10-26' : stage === 'completion_balance' ? '2026-11-01' : '2026-12-01',
    completion: stage === 'contract_tranche' ? null : {
      completionId: 'completion-example-001', approvalId: 'approval-example-001', sessionId: packet.sessionId, projectId: packet.projectId,
      routeId: packet.routeId, routeVersion: packet.routeVersion, completedOn: '2026-11-01',
    },
    ...(stage === 'monthly_fee' ? { monthlyIndex: 1 } : {}),
    settledObligations: stage === 'contract_tranche' ? [] : stage === 'completion_balance' ? first : [...first, ...balances],
  };
}

/** Synthetic paid-record fixtures for testing planner prerequisites; never provider payment evidence. */
export function createExpectedOwnerSettlements(packet: Packet, plan: ReturnType<typeof createSettlementPlan>): SettlementContext['settledObligations'] {
  return plan.entries.map(entry => {
    const parcel = packet.parcels.find(p => p.parcelId === entry.parcelId)!;
    return { obligationId: entry.obligationId, sessionId: packet.sessionId, projectId: packet.projectId,
      routeId: packet.routeId, routeVersion: packet.routeVersion, parcelId: parcel.parcelId, ownerId: parcel.ownerId,
      paymentRecipientRef: entry.paymentRecipientRef, termsVersion: parcel.terms.termsVersion,
      compensationCents: parcel.terms.compensationCents, monthlyRentCents: parcel.terms.monthlyRentCents,
      rentHorizonMonths: packet.rentHorizonMonths, completionId: entry.completionId, completedOn: entry.completedOn,
      amountCents: entry.amountCents };
  });
}

type ValidationCase = {
  id: string;
  description: string;
  check: 'packet' | 'agreement' | 'settlement';
  input: unknown;
  current?: Current;
  context?: SettlementContext;
  expectedError: 'INVALID_INPUT' | 'STALE_VERSION' | 'BLOCKED_STATE';
};

/** No effectful commands: these helpers validate/project inputs and calculate expected plans only. */
export function evaluateOwnerHandoffFixture(item: ValidationCase) {
  try {
    if (item.check === 'packet') OwnerHandoff.parse(item.input);
    else if (item.check === 'agreement') assertAgreementReady(item.input as Packet, item.current!);
    else createSettlementPlan(item.input as Packet, item.context!);
    return { accepted: true, errorCode: null };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'INVALID_INPUT';
    return { accepted: false, errorCode: code };
  }
}

export function createOwnerHandoffExamples() {
  const initial = createInitialOwnerHandoff();
  const accepted = createAcceptedOwnerHandoff();
  const counteroffer = clone(accepted);
  counteroffer.routeStatus = 'selected_for_negotiation';
  counteroffer.revision = 2;
  Object.assign(counteroffer.parcels[0]!.terms, {
    outcome: 'counteroffer', accessConsent: 'unknown', explicitConfirmation: false, confirmationRef: null,
  });
  const ambiguous = clone(counteroffer);
  ambiguous.parcels[0]!.terms.outcome = 'review_required';
  const refused = clone(counteroffer);
  refused.revision = 4;
  Object.assign(refused.parcels[0]!.terms, { outcome: 'refused', accessConsent: 'refused',
    explicitConfirmation: false, confirmationRef: 'fixture-refusal-o001' });
  const rerouted = clone(refused);
  rerouted.routeId = 'route-demo-bypass';
  rerouted.routeVersion = 2;
  rerouted.revision = 5;
  rerouted.parcels = rerouted.parcels.filter(p => p.parcelId !== 'L001');
  // Keep the original role and mock bank identity, but no further live calls after refusal.
  rerouted.owners[0]!.contact = { contactRef: null, registration: 'unregistered', callConsent: false };
  Object.assign(rerouted.parcels[0]!.terms, { outcome: 'pending', accessConsent: 'unknown',
    explicitConfirmation: false, confirmationRef: null, termsVersion: 2 });
  const newDemo = createInitialOwnerHandoff();
  newDemo.sessionId = 'demo-example-002';
  newDemo.projectId = 'project-example-002';
  newDemo.userRole = null;
  newDemo.owners[0]!.contact = { contactRef: null, registration: 'unregistered', callConsent: false };
  const noEligibleRoute = clone(accepted);
  noEligibleRoute.simulationChecksPassed = false;

  const contractContext = createOwnerSettlementContext(accepted);
  const contractPlan = createSettlementPlan(accepted, contractContext);
  const completionContext = createOwnerSettlementContext(accepted, 'completion_balance');
  const completionPlan = createSettlementPlan(accepted, completionContext);
  const monthOneContext = createOwnerSettlementContext(accepted, 'monthly_fee');
  const monthOnePlan = createSettlementPlan(accepted, monthOneContext);
  const monthTwoContext = clone(monthOneContext);
  monthTwoContext.monthlyIndex = 2;
  monthTwoContext.asOfDate = '2027-01-01';
  monthTwoContext.settledObligations.push(...createExpectedOwnerSettlements(accepted, monthOnePlan));
  const monthTwoPlan = createSettlementPlan(accepted, monthTwoContext);
  const partialRetryContext = clone(contractContext);
  partialRetryContext.settledObligations = createExpectedOwnerSettlements(accepted, contractPlan).slice(0, 1);
  const partialRetryPlan = createSettlementPlan(accepted, partialRetryContext);

  const negativeCases: ValidationCase[] = [];
  const agreementCase = (id: string, description: string, packet: Packet,
    current = createOwnerHandoffCurrent(packet), expectedError: ValidationCase['expectedError'] = 'BLOCKED_STATE') => {
    negativeCases.push({ id, description, check: 'agreement', input: packet, current, expectedError });
  };
  const settlementCase = (id: string, description: string, context: SettlementContext,
    expectedError: ValidationCase['expectedError'] = 'BLOCKED_STATE') => {
    negativeCases.push({ id, description, check: 'settlement', input: clone(accepted), context, expectedError });
  };
  agreementCase('pending-terms', 'A selected route and call consent do not imply landowner acceptance.', clone(initial));
  agreementCase('counteroffer', 'A counteroffer is not an accepted agreement.', clone(counteroffer));
  agreementCase('ambiguous-result', 'An unclear model result remains review-required.', clone(ambiguous));
  agreementCase('refused-owner', 'A refused parcel cannot enter the agreement-ready package.', clone(refused));
  agreementCase('no-eligible-route', 'A failed simulation check must not yield an agreement-ready route.', noEligibleRoute);
  const overCap = clone(accepted); overCap.parcels[0]!.offerCapCents = 1100000;
  agreementCase('over-cap', 'Even explicitly accepted terms must remain within the authorized owner cap.', overCap);
  const overBudget = clone(accepted); overBudget.budgetCents = 100;
  agreementCase('over-budget', 'Construction, compensation and the common rent horizon must fit the project budget.', overBudget);
  const approximateRent = clone(accepted); approximateRent.parcels[0]!.terms.monthlyRentIsApproximate = true;
  agreementCase('approximate-rent', 'Rounded map rent equivalents cannot silently become exact accepted terms.', approximateRent, createOwnerHandoffCurrent(approximateRent), 'INVALID_INPUT');
  const missingBank = clone(accepted) as unknown as { owners: Array<Record<string, unknown>> };
  delete missingBank.owners[0]!.banking;
  negativeCases.push({ id: 'missing-banking', description: 'An owner requires an explicit mock payout destination.',
    check: 'packet', input: missingBank, expectedError: 'INVALID_INPUT' });
  const mismatchedBank = clone(accepted); mismatchedBank.owners[0]!.banking.ownerId = 'O002';
  negativeCases.push({ id: 'mismatched-banking', description: 'A payout recipient must belong to the same owner.',
    check: 'packet', input: mismatchedBank, expectedError: 'INVALID_INPUT' });
  const staleRoute = createOwnerHandoffCurrent(accepted); staleRoute.routeVersion = 2;
  agreementCase('stale-route', 'Old route evidence is rejected against the current server state.', clone(accepted), staleRoute, 'STALE_VERSION');
  const staleTerms = createOwnerHandoffCurrent(accepted); staleTerms.termsVersions.L001 = 3;
  agreementCase('stale-terms', 'Accepted terms must have the current per-parcel version.', clone(accepted), staleTerms, 'STALE_VERSION');
  agreementCase('late-callback-after-new-demo', 'A result from the previous session cannot change a new demo.',
    clone(accepted), createOwnerHandoffCurrent(newDemo), 'STALE_VERSION');
  const unsigned = clone(contractContext); unsigned.contracts[0]!.demoSigned = false;
  settlementCase('unsigned-contract', 'Every current route contract needs its simulated signature.', unsigned);
  const unapproved = clone(contractContext); unapproved.approved = false;
  settlementCase('unapproved-package', 'Signatures alone do not provide operator approval.', unapproved);
  const staleApproval = clone(contractContext); staleApproval.approvedPackage.routeVersion = 2;
  settlementCase('stale-approved-route', 'Approval must bind the current route version.', staleApproval);
  const staleContract = clone(contractContext); staleContract.contracts[0]!.contractVersion = 2;
  settlementCase('stale-contract-version', 'Regenerated contracts require a new matching approval.', staleContract);
  const badRecipient = clone(contractContext); badRecipient.contracts[0]!.paymentRecipientRef = 'mock-recipient-o002';
  settlementCase('contract-recipient-mismatch', 'The approved contract recipient must match the owner fixture.', badRecipient);
  const noCompletion = clone(completionContext); noCompletion.completion = null;
  settlementCase('completion-required', 'The balance cannot be planned before an explicit completion event.', noCompletion);
  const noInitialPayment = clone(completionContext); noInitialPayment.settledObligations = [];
  settlementCase('initial-payment-required', 'The initial 20% must be settled before the remaining compensation.', noInitialPayment);
  const beforeDue = clone(monthOneContext); beforeDue.asOfDate = '2026-11-30';
  settlementCase('monthly-fee-not-due', 'The first full monthly fee is due one calendar month after completion.', beforeDue);
  const beforeCompletion = clone(monthOneContext); beforeCompletion.completion = null;
  settlementCase('no-pre-completion-rent', 'No monthly fee can accrue/pay without completion.', beforeCompletion);
  const duplicate = clone(contractContext); duplicate.settledObligations = createExpectedOwnerSettlements(accepted, contractPlan);
  settlementCase('duplicate-obligation', 'Changing a request key does not create another business obligation.', duplicate);
  const regenerated = clone(duplicate);
  regenerated.contracts = regenerated.contracts.map(c => ({ ...c, contractId: `${c.contractId}-regenerated`, contractVersion: c.contractVersion + 1 }));
  regenerated.approvedPackage.contractVersions = Object.fromEntries(regenerated.contracts.map(c => [c.contractId, c.contractVersion]));
  settlementCase('regenerated-contract-duplicate', 'Regenerating a contract cannot create another payment for the same session/parcel/stage.', regenerated);

  const wrongPaidAmount = clone(completionContext); wrongPaidAmount.settledObligations[0]!.amountCents += 1;
  settlementCase('incorrect-settled-amount', 'Settled IDs alone cannot prove the correct tranche was paid.', wrongPaidAmount);
  const changedBasis = clone(accepted);
  changedBasis.parcels[0]!.terms.compensationCents = 1300000;
  changedBasis.parcels[0]!.terms.termsVersion = 3;
  const changedBasisContext = createOwnerSettlementContext(changedBasis, 'completion_balance');
  changedBasisContext.settledObligations = clone(completionContext.settledObligations);
  negativeCases.push({ id: 'changed-terms-after-initial-payment',
    description: 'Changing approved compensation after an initial payment requires an explicit adjustment workflow; it cannot recompute an unrelated 80% balance.',
    check: 'settlement', input: changedBasis, context: changedBasisContext, expectedError: 'BLOCKED_STATE' });

  const changedCompletion = clone(monthTwoContext);
  changedCompletion.completion!.completedOn = '2026-12-01';
  changedCompletion.asOfDate = '2027-02-01';
  settlementCase('changed-completion-date-after-rent', 'Moving completion after payments must not create a new rental period or another obligation.', changedCompletion);
  const changedCompletionId = clone(monthTwoContext);
  changedCompletionId.completion!.completionId = 'replacement-completion';
  settlementCase('changed-completion-identity', 'Settled balances and rent bind the original completion event.', changedCompletionId);
  const extendedHorizon = clone(accepted);
  extendedHorizon.rentHorizonMonths = 3;
  for (const parcel of extendedHorizon.parcels)
    parcel.terms.comparisonRentTotalCents = parcel.terms.monthlyRentCents * 3;
  const extendedHorizonContext = createOwnerSettlementContext(extendedHorizon, 'monthly_fee');
  extendedHorizonContext.monthlyIndex = 3;
  extendedHorizonContext.asOfDate = '2027-02-01';
  extendedHorizonContext.settledObligations = clone(monthTwoContext.settledObligations);
  negativeCases.push({ id: 'changed-rent-horizon-after-payment',
    description: 'Extending the rent horizon after settlement requires a separately approved adjustment; it cannot create an extra month silently.',
    check: 'settlement', input: extendedHorizon, context: extendedHorizonContext, expectedError: 'BLOCKED_STATE' });

  const plans = [contractPlan, completionPlan, monthOnePlan, monthTwoPlan];
  return {
    metadata: {
      format: 'easygrid-owner-development-examples-v1', issue: 'CAL-27', sourceMode: 'fixture',
      description: 'Isolated fictional two-parcel development scenario, not the 24-parcel map dataset.',
      execution: 'Pure schema/policy examples only; no calls, signatures, approvals, transfers or database mutations executed.',
      compatibility: 'OwnerHandoff v1 is a separate contract; it is not the legacy API v1 Snapshot or map envelope version.',
      money: 'USD integer cents; contract tranche=floor(compensationCents/5), balance=exact remainder. Monthly fees are separate.',
      contact: 'References and consent flags are invented. They are not real registrations or consent evidence.',
      dates: 'Illustrative demo-clock dates, not operational deadlines.',
    },
    packets: { initial, counteroffer, ambiguous, accepted, refused, rerouted, newDemo },
    voice: { initial: createVoiceHandoff(initial), accepted: createVoiceHandoff(accepted), rerouted: createVoiceHandoff(rerouted) },
    settlement: {
      contexts: { contract: contractContext, completion: completionContext, monthOne: monthOneContext, monthTwo: monthTwoContext },
      expectedPlans: { contract: contractPlan, completion: completionPlan, monthOne: monthOnePlan, monthTwo: monthTwoPlan },
      expectedLedger: plans.flatMap(plan => plan.entries.map(entry => ({ ...entry,
        mode: 'simulated' as const, status: 'expected_simulated_paid' as const, stage: plan.stage, currency: plan.currency }))),
      expectedTotals: { compensationCents: 2000000, contractTrancheCents: 400000, completionBalanceCents: 1600000,
        twoMonthlyFeesCents: 100000, landownerSettlementCents: 2100000, constructionExcluded: true },
    },
    retry: { context: partialRetryContext, expectedPlan: partialRetryPlan,
      description: 'O001 already has a valid initial-tranche record; retry plans only O002. No repeated payment and no blocked unpaid owner.' },
    negativeCases,
    adapterScenarios: {
      noEligibleRoute: { recommendation: null, status: 'review_required', reasons: ['Every evaluated route failed at least one simulation/cap/budget check.'] },
      refusalReroute: { originalUserRole: refused.userRole, currentUserRole: rerouted.userRole,
        excludedParcelIds: ['L001'], userLiveCallsDisabled: true, remainingOwnersUseSimulation: true },
      newDemo: { previousSessionId: accepted.sessionId, sessionId: newDemo.sessionId,
        previousResultsRetained: true, previousBindingCleared: true, previousContactConsentReused: false },
      limitation: 'These response/lifecycle sketches are adapter acceptance expectations, not implemented routing, server persistence or provider behavior.',
    },
  };
}

export function validateOwnerHandoffFixtures(): void {
  const examples = createOwnerHandoffExamples();
  for (const packet of Object.values(examples.packets)) OwnerHandoff.parse(packet);
  assertAgreementReady(examples.packets.accepted, createOwnerHandoffCurrent(examples.packets.accepted));
  for (const item of examples.negativeCases) {
    const actual = evaluateOwnerHandoffFixture(item);
    if (actual.accepted || actual.errorCode !== item.expectedError) {
      throw new Error(`Owner handoff fixture ${item.id}: expected ${item.expectedError}, received ${actual.errorCode ?? 'accepted'}`);
    }
  }
  const plans = Object.values(examples.settlement.expectedPlans);
  const total = plans.reduce((sum, plan) => sum + plan.totalCents, 0);
  if (total !== examples.settlement.expectedTotals.landownerSettlementCents) throw new Error('Owner handoff fixture totals do not reconcile');
  if (new Set(examples.settlement.expectedLedger.map(row => row.obligationId)).size !== 8) throw new Error('Owner handoff fixture obligations collide');
}
