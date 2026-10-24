# CAL-36–39 Finance / Hyphenate / Nessie demo handoff

## Status
- Pure TypeScript adapter and tests; **not** integrated with Theo's CAL-27 revised shared API or Pratham's SpacetimeDB service yet.
- No real payments, bank transactions, legal easements, or signatures. Nothing in this branch proves external Nessie access.
- Existing CAL-13 adapter remains unchanged. This branch builds on PR #2; draft PR #4 is incremental.

## Required integration with CAL-27 / CAL-29
1. Map revised CAL-27 accepted negotiation terms, route/session/owner role and parcel-wire intersections to `AgreedParcel` and `finalParcelIds`.
2. Use CAL-27's **authoritative** cent-rounding rule; this isolated adapter documents half-up 20% and exact remainder as a provisional rule. Reconcile if Theo chooses a different rule.
3. Gate creation until all final-route parcels explicitly accepted; use `buildAgreementPackage`, then `demoSignAgreement` for each.
4. Manager approves a signed package through `approvePackage`; requester and approver must differ. Version/package changes invalidate approval.
5. Call `payContractTranches`, then `simulateCompletion` (only after all first tranches posted), then `postMonthlyRent` at calendar month +1/+2.
6. Backend MUST transactionally enforce authorization, persistence, unique obligation IDs, session identity, replay protection and atomic operations. The pure functions do **not** implement cross-process or durable duplicate defense.
7. Use `resetDemo` with a new session and reject late callbacks carrying an old session ID at the backend boundary.

## Hyphenate track evidence
The supplied track PDF requests an autonomous finance-team workflow, realistic conflicting data, multi-period state, approval separation, auditability and an exception-handling moment. Its deliverables are code, a **demo video opening with the moment**, a **live judging demo**, **one line naming the finance seats**, and **proof showing what is real vs simulated**.

**Finance seats:** Easement Accounts Payable Agent + Financial Controller/Reconciliation Agent.
**Moment:** Show month 1 correctly matched, month 2 deliberately underpaid by 101 cents on parcel A; the agent flags the discrepancy with the contract hash, ledger obligation ID, and evidence rather than silently marking it paid.
**Controls:** Requester cannot approve their own payment; no 80% before 20%; no rent before completion; duplicate business obligations rejected even if a new request key is used; every posted journal has matching debit and credit; audit events record actor, time and reason.
**Honest boundaries:** No real bank feeds, legal signatures, autonomous external payments or completed SpacetimeDB persistence are claimed.

## Capital One — Best Use of Nessie
Nessie is Capital One's **mock banking REST API**. The `NessieSandbox` adapter supports server-side authenticated read-only requests to `/accounts`, `/accounts/{id}`, `/accounts/{id}/deposits`, and `/accounts/{id}/withdrawals`. It has unit tests with an injected mock transport. To qualify credibly for a Best Use prize, wire real sandbox responses into a finance view and demonstrate them using a valid Nessie API key. **No key has been supplied; no live Nessie call has been made.** Do not show a simulated internal ledger entry as if it were a Nessie bank transaction. Keep `NESSIE_API_KEY` server-side and do not log URLs with query-string credentials.

## Test commands
```sh
cd packages/contracts
npm ci --ignore-scripts
npm run check
```
Attach the **new** CI run URL and final passing commit to CAL-36 before checking its revised criteria. Earlier 35/35 success only applies to old CAL-13 behavior.

## Submission
Cal Hacks 13.0 official Devpost deadline: **Oct 25 2026, 09:00 PDT** (internal freeze target 08:00 PDT).
