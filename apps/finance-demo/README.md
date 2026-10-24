# Connected demo using the REAL finance reducers

From repository root:

```bash
cd packages/contracts && npm ci && cd ../..
node --experimental-strip-types apps/finance-demo/server.ts
```

Then open **http://127.0.0.1:4173/** in a browser. The HTTP adapter calls the actual CAL-37 approval/20% functions and CAL-38/39 completion, 80%, and monthly reconciliation reducers. A server-side, synthetic signed agreement fixture is used; no UI-side financial decision is authoritative. The server listens on loopback only and never moves real funds.

The adapter is intentionally in-memory and resets on server restart. It is **not** the team's CAL-29 SpacetimeDB state service. No shared application files were changed. See `apps/finance-demo/server.test.ts` for the domain-connected regression walkthrough. To run the test:

```bash
cd apps/finance-demo && npm test
```

The original `index.html` is the earlier UI-only fixture; **connected.html** is the server-rendered browser interface served at `/`. Full refresh/restart persistence and CAL-41 mounting remain pending.

---

# EasyGrid finance-only UI (CAL-37/38/39)

Open `index.html` in a browser. No build, keys, external network, backend, or dependency is required.

**Scope:** isolated interactive *fixture demo* of approval, simulated 20% settlement, gated completion, simulated 80% settlement, and two monthly periods. This file does not edit the shared map app, server, CAL-29 SpacetimeDB, or any teammate's files.

**Safety and truthfulness:** all payments and owners are fictional; no real money moves. State lives in browser memory only and **resets on refresh**. UI fixture rules duplicate the domain intent but do **not** call the production TypeScript CAL-37/38/39 reducers or authoritative store. This is not end-to-end acceptance evidence and is not a connected Nessie/Hyphenate integration.

## Manual acceptance walkthrough

1. On load, completion and monthly buttons are disabled. Try approving the fixture agreement.
2. Simulate a failed 20% attempt. Observe attempted/unmatched ledger; retry with successful 20%.
3. Simulate completion; the second click is disabled. Simulate failed 80%, retry successful 80%.
4. Advance to month one; record matching payments; advance to month two and inject $50 mismatch for O001. Inspect expected/paid/discrepant totals and per-owner receipt rows.
5. Confirm that a second obligation for the same owner/period cannot be recorded, and no rent is available before completion.
6. Refresh the browser. The demo resets deliberately; persistence is **not** implemented.

## Integration contract for the team

- CAL-29 must expose authoritative state and transactional mutation methods with stable business obligation uniqueness; no UI-side memory state may be used as the source of truth.
- CAL-41 can mount this layout in the shared application, replace local handlers with server-authorized CAL-37/38/39 operations, display returned failure prerequisites, and restore public state after refresh.
- Keep simulated labels, synthetic masked destination displays and server-side provider secrets.
- Until that work is complete, do not check the original full-stack Acceptance Criteria as completed.
