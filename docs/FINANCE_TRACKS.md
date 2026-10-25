# Finance track implementation and evidence

Updated October 25, 2026. Current EasyGrid contract flow: approved fictional negotiation -> authoring -> both simulated signatures on every final-route agreement -> explicit submission -> one full compensation payment per owner -> bank/ledger reconciliation. Deposits, completion balances and construction payment gates are superseded. Current Nessie mode registers an exact full-amount provider record only; it does not establish payment or move account balances. Local simulation retains its simulated paid journal.

## Confirmed event sources

- [Cal Hacks 13.0 official Devpost](https://cal-hacks-13-0.devpost.com/) lists **Capital One - Best Use of Nessie** and **Hyphenate - The Hyphenated Enterprise: Autonomous Systems for Finance**.
- The user-provided four-page `CalHacks_Hyphenate_Track.pdf` supplies the detailed Hyphenate brief. It permits the team's choice of models, frameworks, sandboxes and mocks; it does not state that a proprietary Hyphenate API must be used.
- The current [Nessie official documentation](https://prod.nessieisreal.com/docs#Transfers) lists transfer-by-ID reads, updates and deletion. Account-scoped transfer list/create routes are evidenced by the historical [official Go transfer SDK](https://github.com/nessieisreal/nessie-golang-sdk/blob/master/lib/transfer/transfer.go), but were absent from the current Swagger listing when reviewed. The older [official JavaScript transfer SDK](https://github.com/nessieisreal/nessie-javascript-sdk/blob/master/lib/transfer.js) has an inconsistent creation path. Historical SDK code does not establish current deployed compatibility.

## Hyphenate: the company and seats

**Company:** EasyGrid, a fictional utility acquiring transmission-corridor rights.

**Seats:** contract accountant and accounts-payable execution/reconciliation worker, supervised by a utility controller.

The worker responds to contract-submission events, derives the approved obligation, reads bank evidence, checks authorization/recipient/balance, executes an eligible payout, reconciles it and posts a balanced demo journal. Unexpected evidence is held or escalated with reasons. The requester cannot approve its own request. Every action carries actor, source document, route/negotiation version, rule and result evidence.

This is a **rule-based event worker**, not a live LLM agent or a connected Hyphenate product. The PDF's autonomy criterion should be demonstrated through actual execution and exception recovery; a static narrative alone is not sufficient evidence.

| Brief emphasis | Implemented evidence | Still needed for the submission |
| --- | --- | --- |
| Realistic finance work and imperfect inputs | Exact obligation/recipient checks and planted destination, amount and balance errors | Demonstrate a judge-supplied scenario and show expected vs observed results |
| Limited access and independent sign-off | Separate requester/controller/landowner capabilities, exact signature binding | Authenticated shared-service identities; current actors are explicit simulations |
| Explainability and accountability | Source-bound audit events, reconciliation and balanced demo journal | Capture an inspectable run and explain each held decision |
| Recovery and working with people | Controller rejection, recovery from an unattempted hold, no blind retry after uncertainty | Live presentation of a refusal/exception and safe recovery |
| Behavior across time | Versioned saved drafts and restart-restored obligations/signatures | Demonstrate refresh recovery without submitting another full payment |

The brief asks for code, a video opening with the distinctive failure-catching/recovery moment, a working live judging demo, a one-line description of the seats filled, and evidence separating real and simulated behavior. It does not require recurring-rent functionality.

## Capital One: single-payment API and track review

The official Devpost prize is **Best Use of Nessie**. Its public description and
the [event rules page](https://cal-hacks-13-0.devpost.com/rules) do not specify
installments, construction milestones, recurring payments, real-money banking,
a minimum endpoint count or a required transfer endpoint. The single 100%
payment therefore has no identified conflict with the published track.
This is not a guarantee of sponsor eligibility or a complete unpublished rubric.

| Review item | Evidence and current result |
| --- | --- |
| Use Nessie meaningfully | Recommended evidence is a real request to the Nessie sandbox in the contract payment flow. A local demo bank or mocked fetch cannot establish actual integration. This is an inference from the track's purpose, not an extra quoted rule. |
| Single 100% compensation | Every final-route agreement must be signed and approved. The server derives the full compensation once per owner; construction is not a prerequisite. Retired installment requests and prior attempted installments are blocked. |
| Actual API versus real money | Nessie describes a banking simulation. Real HTTP calls create sandbox records; the current API response does not establish movement of funds or recipient settlement. Real-money banking is not required by the published listing. |
| Authentication and API origin | Current authentication docs use GitHub-issued keys in the `key` query parameter. Swagger lists `https://prod-api.nessieisreal.com`; the getting-started page uses another origin. The configured origin follows Swagger and the narrower prior browser success. Keys remain server-side. |
| Current transfer compatibility | Live validation requires `transaction_date` and `status`, rejects legacy `medium` and `payee_id`, and coerces fractional dollars to integers. Creation returns `objectCreated._id`; GET/list rows use `id` without recipient fields. The adapter registers whole-dollar records only and blocks cents before POST without changing the contract. |
| Product correctness | Exact amount, signer/package/recipient binding, durable no-resend behavior and full-payment migration guards remain required. Nessie records never produce a paid journal or unlock construction, even if a record status says completed. |
| Remaining live evidence | The configured payer and all 26 synthetic recipient accounts are verified. The current service accepts record creation but supplies no recipient settlement evidence. The live signed-contract record demonstration is tracked in CAL-37; do not describe record registration as a completed payout. |
| Event submission | Devpost asks for a project image, GitHub code, and a recorded/live demonstration; its functionality criteria also call for a clear video for asynchronous sponsor judging. Code delivery alone does not verify submission completion. |

The published prize description says $300 Giftogram per winning team member;
the $1,200 headline should not be described as a guaranteed cash payout to this
three-person team. No additional Capital One-specific judging weights were found.

`apps/map-preview/server/nessie-sandbox.mjs` is a server-only HTTP adapter. It verifies configured account identities, reads account-scoped records, submits at most one explicitly enabled record, then verifies the provider-generated identity and exact amount/marker on readback. A verified record is `recorded`, never `paid`. The marker binds the intended owner but is not evidence that the owner received funds.

Provider credentials and account/customer IDs stay in server environment configuration. The browser receives only masked transaction references and safe status/evidence. Redirects and unapproved API origins are rejected. Provider POSTs have no automatic retries and use no undocumented idempotency header.

Set these in the local server environment or an ignored `.env` loaded by Node. Never put actual values in Git, UI fields, chat, screenshots or CI logs:

```dotenv
EASYGRID_PAYMENT_PROVIDER=nessie
NESSIE_API_ORIGIN=https://prod-api.nessieisreal.com
NESSIE_API_KEY=replace-locally
NESSIE_PAYER_ACCOUNT_ID=replace-with-a-sandbox-payer
NESSIE_OWNER_RECIPIENTS={"OWNER-DEMO-004":{"accountId":"replace-payee-004","customerId":"replace-customer-004"},"OWNER-DEMO-009":{"accountId":"replace-payee-009","customerId":"replace-customer-009"}}
NESSIE_ALLOW_SANDBOX_TRANSFERS=no
```

Confirm the current API origin and create funded fictional accounts using the provider's sandbox tooling. Start the server with Node's `--env-file` option if using an ignored local file. With writes disabled, bank evidence can be read but a new record is held. Change the final flag to `yes` only for an intended sandbox demonstration. No real-fund banking provider is supported.

**Verified in tests:** intended HTTP request paths/body, exact cents, ID checks, redaction, enabled-write guard, record-versus-settlement distinction and failure handling with mocked fetch. HTTP path assertions alone do not verify the deployed API contract.

**Historical browser evidence:** the earlier staged-payment version was checked for approval gating, contract generation/editing, browser draft save/restore, simulated click signatures, complete-package signature gating, changed-recipient hold/recovery, initial-payment completion, refresh restoration, duplicate-payment lock and HTML download at desktop and narrow widths. This evidence does not by itself verify the revised full-payment UI, the map's GPU behavior or authoritative shared-state integration.

**Not established by this change:** recipient settlement, a live LLM reasoning trace or full SpacetimeDB/shared-state integration. See [Nessie setup and live compatibility evidence](NESSIE_SETUP.md). The demo uses local simulation by default; Nessie mode is explicitly record-only and preserves exact amounts, signatures, recipient binding and duplicate protection. Do not claim sponsor qualification from mocked tests or the existence of the adapter.
