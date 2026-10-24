# CAL-36–39 finance workflow + sponsor tracks (pure modules)

This branch contains **no standalone finance UI**, no modifications to Theo's PR #3 map UI, and no separate finance HTTP server. It is stacked on CAL-37 PR #9, which in turn consumes CAL-36 agreement/signature guards. No real money is transferred.

## Linear capability mapping

| Work item | Source | Current evidence | Still requires owner integration |
| --- | --- | --- | --- |
| CAL-36 | `cal36-easement.ts`, `cal36-shared-handoff.ts` | Version-bound simulated agreements/signatures; accepted-route gating | CAL-29 canonical storage, CAL-41 shared UI |
| CAL-37 | `cal37-approval.ts` (PR #9) | Manager approval, signed agreement validation, exact per-parcel 20%, failed-retry/duplicate guards | Shared UI and authoritative SpacetimeDB transaction |
| CAL-38 | `cal38-39-settlement.ts` | Immutable completion and exact 80%, only after 20%; stable obligations | CAL-29 atomic commit and real shared UI |
| CAL-39 | `cal38-39-settlement.ts` | One-month anniversaries, two demo periods, monthly discrepancy projections | Persistent demo clock, refresh/restart proof, real shared UI |

CAL-29 and CAL-41 integration is **not** completed by these files. Tests run on synthetic data and cannot establish live application correctness.

## Capital One: Best Use of Nessie

`finance-agent-workflow.ts` provides `collectNessieEvidence`, a **real HTTP adapter** for the Nessie API sandbox at `https://api.nessieisreal.com/` or its documented legacy host. It verifies one sandbox account's ID and lists deposits and withdrawals using **GET requests only**, converting exact dollars to integer cents, validating response identity and record shape. An injected `fetch` allows real server operation and mocked CI without secrets.

Usage in a trusted Node backend only:

```ts
import {collectNessieEvidence} from './src/finance-agent-workflow.ts';
const evidence=await collectNessieEvidence({
 baseUrl:'https://api.nessieisreal.com/',
 apiKey:process.env.NESSIE_API_KEY!,
 sandboxAccountId:process.env.NESSIE_SANDBOX_ACCOUNT_ID!,
 fetcher:fetch,
});
console.log(evidence.transactions.length, evidence.accountVerified); // no keys, no account details
```

The sandbox account is **NOT** an EasyGrid owner bank reference; do not automatically link evidence to settlement or count unrelated deposits as proof of a payment. Do not use real banking credentials or add the key to a URL visible to the browser. **Real Nessie credentials, a live sandbox call, and a demonstrable use of Nessie inside the submitted project are still required** to credibly claim this sponsor category.

For a **live read-only sandbox smoke test** (in a trusted terminal with provider credentials, never in a browser):

```sh
cd packages/contracts
NESSIE_API_KEY='YOUR_SANDBOX_KEY' NESSIE_SANDBOX_ACCOUNT_ID='YOUR_SANDBOX_ACCOUNT' node --experimental-strip-types scripts/nessie-smoke.ts
```

This command only prints whether sandbox verification succeeded and transaction count. It does not claim any EasyGrid obligation was paid. Run only with your own sandbox test credentials; do not paste the secret into chat, GitHub or CI.

## Hyphenate: The Hyphenated Enterprise — Autonomous Systems for Finance

`planFinanceAgent` autonomously categorizes finance exceptions, proposes evidence/retry/reconciliation actions and requires human approval before any action is executed. Every recommendation is `autoExecute:false`, preventing an AI decision from mutating compensation or fabricating transfers. Source-of-truth inputs are authoritative CAL-37/38/39 state from the host, with optional Nessie sandbox evidence. The reason trace is deterministic and inspectable.

This is an **agent workflow foundation**, not a live Hyphenate product/API integration, LLM-driven action loop, or confirmed sponsor eligibility. Connect a real model/tool runtime in the team's owned service, log approvals/rejections, and demonstrate the workflow to judges; do not claim the challenge was met from a static projection alone.

## Verification

```sh
cd packages/contracts
npm ci
npm run check
```

The new tests cover Nessie read-only endpoints, API-key exfiltration guards, strict cents conversion, account ID mismatch, nonmutating policy recommendations, and discrepancy escalation. Domain tests cover contract approvals, completion and two-month reconciliation.

**Security & policy:** None of these functions perform bank transfers, legal signatures, contacting property owners, or unauthorized financial actions. Sponsor credentials and live account identifiers must remain in backend environment variables, not Git, the UI, fixtures or logs.

## Hackathon submission

Cal Hacks 13 Devpost requires a repository, project image, and a live or recorded demo, plus the team pitch. The sponsor categories must be explicitly selected in the submission. A judge will evaluate actual app usage and functionality, not simply the presence of an adapter. Deadline shown by Devpost: October 25, 2026, 9:00 a.m. PDT.
