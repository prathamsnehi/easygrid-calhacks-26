/**
 * CAL-39 / Hyphenate: evidence-based, bounded finance reconciliation agent.
 * The agent proposes actions, NEVER approves or executes payments.
 * Pure injected dependencies keep the workflow testable without live credentials.
 */
export type BankMovement = { transactionId: string; amountCents: number; period: string; obligationId: string; source: 'nessie' | 'mock' };
export type RentObligation = { obligationId: string; agreementId: string; period: string; expectedCents: number; contractHash: string };
export type ReviewDecision = {
  obligationId: string; period: string; expectedCents: number; observedCents: number;
  differenceCents: number; status: 'matched' | 'underpaid' | 'overpaid';
  transactionIds: string[]; evidence: string[]; suggestedAction: 'none' | 'request_review';
  explanation?: string;
};
export type AgentReport = { sessionId: string; runId: string; createdAt: string; decisions: ReviewDecision[]; requiresHumanApproval: boolean };
export type AgentDependencies = {
  loadObligations(sessionId: string): Promise<RentObligation[]>;
  loadBankMovements(sessionId: string): Promise<BankMovement[]>;
  explain?(facts: Omit<ReviewDecision, 'explanation'>): Promise<string>;
};
const validCents = (n: number) => Number.isSafeInteger(n) && n >= 0;
export async function runFinanceReconciliation(
  sessionId: string, runId: string, createdAt: string, deps: AgentDependencies
): Promise<AgentReport> {
  if (!sessionId.trim() || !runId.trim() || !createdAt.trim()) throw new Error('Audit identifiers required');
  const [obligations, movements] = await Promise.all([
    deps.loadObligations(sessionId), deps.loadBankMovements(sessionId)
  ]);
  const ids = new Set<string>();
  for (const o of obligations) {
    if (!o.obligationId || !o.period || !o.contractHash || !validCents(o.expectedCents))
      throw new Error('Invalid contract obligation');
    if (ids.has(o.obligationId)) throw new Error('Duplicate contract obligation');
    ids.add(o.obligationId);
  }
  const txIds = new Set<string>();
  for (const m of movements) {
    if (!m.transactionId || !m.period || !m.obligationId || !validCents(m.amountCents))
      throw new Error('Invalid bank evidence');
    if (txIds.has(m.transactionId)) throw new Error('Duplicate bank transaction');
    txIds.add(m.transactionId);
  }
  const decisions: ReviewDecision[] = [];
  for (const o of obligations) {
    const matching = movements.filter(m => m.obligationId === o.obligationId && m.period === o.period);
    const observed = matching.reduce((n, m) => {
      const sum = n + m.amountCents;
      if (!Number.isSafeInteger(sum)) throw new Error('Unsafe transaction total');
      return sum;
    }, 0);
    const diff = o.expectedCents - observed;
    if (!Number.isSafeInteger(diff)) throw new Error('Unsafe difference');
    const status = diff === 0 ? 'matched' : diff > 0 ? 'underpaid' : 'overpaid';
    const facts: Omit<ReviewDecision, 'explanation'> = {
      obligationId: o.obligationId, period: o.period, expectedCents: o.expectedCents,
      observedCents: observed, differenceCents: diff, status,
      transactionIds: matching.map(m => m.transactionId),
      evidence: ['contract:'+o.contractHash, ...matching.map(m => m.source+':'+m.transactionId)],
      suggestedAction: diff === 0 ? 'none' : 'request_review'
    };
    let explanation: string | undefined;
    if (diff !== 0 && deps.explain) {
      try { explanation = await deps.explain(facts); }
      catch { explanation = 'Automated explanation unavailable; manual review required.'; }
    }
    decisions.push({ ...facts, ...(explanation ? {explanation} : {}) });
  }
  // Unmatched bank transactions are never silently ignored.
  for (const m of movements) {
    if (obligations.some(o => o.obligationId === m.obligationId && o.period === m.period)) continue;
    decisions.push({
      obligationId: m.obligationId, period: m.period, expectedCents: 0,
      observedCents: m.amountCents, differenceCents: -m.amountCents,
      status: 'overpaid', transactionIds: [m.transactionId],
      evidence: [m.source+':'+m.transactionId], suggestedAction: 'request_review',
      explanation: 'No matching contractual obligation was found for this bank movement.'
    });
  }
  return {
    sessionId, runId, createdAt, decisions,
    requiresHumanApproval: decisions.some(d => d.suggestedAction === 'request_review')
  };
}
