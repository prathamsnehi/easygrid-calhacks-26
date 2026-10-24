# CAL-41 — QuickGrid refusal to contracts

Based on main a8d1bf9 with Seohyun's PRs #17–#19 (de765c6). Their contract workspace, local development ledger, signature gates, 20% initial payment and explicit completion balance are preserved.

Run `npm ci --ignore-scripts --prefix packages/contracts`, then `npm run dev --prefix apps/map-preview`. The map is at http://127.0.0.1:4177/ by default. Set EASYGRID_PREVIEW_PORT to choose another port. /contracts.html remains the independent fixture example.

In the map, register a fictional demo participant, place A/B and analyze an eligible route. Click **Simulate refusal**. Once the new route is confirmed, **Continue to contract & settlement** in either the map overview or analysis panel opens the full contract workspace. The excluded participant keeps the original role but is not included in the contract/payment parcels. The earlier faded route and bold updated route stay available on the map.

Preparing contracts registers the exact current proposal with the local server. Public routing restrictions accompany the redacted proposal; the server rebuilds the constrained geometry, original owners, amounts and recipients from trusted fixtures and checks the complete binding. No browser-supplied compensation overrides it. Duplicate clicks are blocked while preparing. Route, participant or context changes abort pending preparation and invalidate the previous workspace.

The route demo assumes fictional owner acceptance only. Every final-route contract still requires both simulated signatures before initial payments; all initial payments must be confirmed before construction, and explicit completion must precede each remaining balance payment. No payment is triggered by opening the workspace. Monthly payment controls are not included.

The host retains setContractNegotiation, setContractAgreement, setConstructionHandler, reportConstructionComplete and closeContracts on window.easygridDemo. Live calls, canonical SpacetimeDB registration, authenticated roles and the actual construction animation remain separate integration work.

Validation: the existing suite initially passed 151/152 locally with one obsolete static-summary assertion. The updated compiled-UI refusal navigation test and the new server/API refusal-through-both-tranches test both passed locally. The workstation disconnected during browser verification after the QuickGrid onboarding page loaded; full visual contract/payment QA is still pending. See the draft PR for exact-commit CI results.
