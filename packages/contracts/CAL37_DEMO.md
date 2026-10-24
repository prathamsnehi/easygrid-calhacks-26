# CAL-37 simulated payment demo (LOCAL FALLBACK)

This runnable UI exercises the CAL-36 signed-contract fixture, CAL-27 owner-linked mock banking and the CAL-37 manager approval / first 20% simulated payment flow.

```bash
cd packages/contracts
npm ci
npm run demo:cal37
# open http://127.0.0.1:4177
```

**SIMULATED ONLY — NO REAL FUNDS TRANSFERRED.** The server listens on localhost only and uses invented owners, accepted terms and already-simulated owner signatures. The operator must explicitly approve the package, then explicitly authorize a simulated payment. Failed attempts can be retried without re-paying already paid obligations. Refresh restores state from a local JSON file (default `packages/contracts/.cal37-demo-state.json`, override `CAL37_STATE_FILE`). Delete that file to reset the local demo. The file contains only synthetic demo data; it is NOT a production storage format. The server never invokes the legacy deposit endpoint, Nessie, a bank or a real signing provider.

This fallback implements **in-process revision CAS and local atomic file replacement** for one demo server process; it is **NOT SpacetimeDB** and is not a distributed transaction. Do not deploy publicly or claim CAL-29 authoritative state, concurrent multi-process safety, authorization, real provider API integration, or CAL-38/39 completion/rent integration. To integrate with CAL-29, implement `Cal37AuthoritativeStore` using the team's authoritative service, with a single transactional CAS on the session revision and unique business-obligation IDs. Server-side owner/session checks and refresh/reconnect should be verified against that real service before checking the final Linear acceptance item.

## Test evidence

Contract unit tests exercise explicit approval, signatures, stale state, exact 20% amounts, masked receipts, duplicate obligations, partial retry, forged ledger rejection and CAS conflict. The runnable fallback's UI and HTTP server are not covered by those unit tests; manually demonstrate the above flow before claiming the UI is end-to-end verified.
