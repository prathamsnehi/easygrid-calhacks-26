# Map → parcel analysis → voice agent

Tracked in [CAL-23](https://linear.app/easygrid-calhacks-2026/issue/CAL-23/prepare-route-parcel-analysis-and-judge-roleplay-handoff-for-pratham), related to CAL-7, CAL-8, CAL-10 and CAL-16.

This slice collects a consented demo participant before planning, then prepares the selected transmission route and the fictional landowner that participant will play. Registration on **Start demo** is local page state. It does not dial a phone, import a project into a backend, register a server contact, record land access, or create an agreement. The map, parcel data and cost assumptions are synthetic.

## Operator flow

1. On **Start demo**, enter the participant's name and phone number, then check the explicit AI roleplay call consent box. All three are required. US 10-digit numbers receive `+1` automatically; an 11-digit number starting with `1` is also accepted, and explicit international prefixes are preserved. The private callback receives the normalized `phoneE164` value. Select **Start demo** to validate registration and unlock planning. This does not deliver private data to the host or start a call.
2. Place **A · Substation** and **B · Data center**. Review the recommended connection or choose another route.
3. The app binds the registered participant to exactly one affected parcel on the selected route, including the recommended optimal route. It retains that parcel on route changes when possible; otherwise it chooses another affected parcel deterministically. The base owner and parcel fixtures remain unchanged.
4. Choose **Analyze affected parcels** to open **Land & people**. Each affected parcel shows its owner role, crossed centerline length, pylons/foundation area, fictional upfront compensation and rent. The participant summary uses the startup registration; there is no second participant-entry form.
5. Export the redacted handoff JSON or use **Prepare participant handoff** after the host registers the integration callback. Only this explicit preparation action delivers the private participant to the handler. Preparation does not start a call. Pratham's integration owns the later explicit call action.

The judge role's call consent and the fictional parcel's land-access consent are separate. Entering a phone number never marks a parcel allowed or an agreement accepted.

**Edit participant** in the toolbar or participant summary returns to the startup screen and invalidates any pending handoff. Endpoints are preserved, but planning and routing remain locked until registration is validated again. Reset, reload and `pagehide` erase participant details and require registration again. Names and phone numbers exist only in page memory. Reload may restore validated endpoint coordinates from local storage, but it never restores participant registration or bypasses the startup gate.

## Browser integration

The standalone app exposes:

```js
window.easygridDemo.getHandoff(); // Redacted packet; null until participant + route are ready.

window.easygridDemo.setHandoffHandler(async ({ handoff, participant, signal }) => {
  // The only private contact delivery path. Called by Prepare participant handoff,
  // never by Start demo or local participant registration.
  // participant = { alias, phoneE164, consent: true }
  // handoff contains no entered alias or phone number.
  // signal is aborted on relevant edits, route changes, or reset.
});
```

The host callback's successful resolution means only that the host received the handoff. Its return value is not interpreted as a successful call. The global `getHandoff()` method returns `null` before valid registration, while participant editing locks the demo, or when no current route exists. Do not log the callback argument: it includes the participant's name and phone number. Store the dial target privately on the server, return an opaque contact reference, and keep provider credentials on the server. No public packet, URL, fixture, repository file, or browser persistent storage needs the real phone number.

The callback is a same-page integration seam. It does not automatically cross an iframe boundary. If the team embeds the map in a separate iframe, implement and validate an explicit origin-restricted bridge or integrate the source modules into the team frontend. Do not broadcast private participant data with wildcard `postMessage`.

## Public packet

`apps/map-preview/src/handoff.js` exports `createHandoff(...)`. The packet uses `kind: "easygrid-map-handoff"`, `schemaVersion: 1`, and `sourceMode: "fixture"`.

`npm run build --prefix apps/map-preview` also generates `apps/map-preview/dist/demo-handoff-example.json` from the baseline A(−43, −17) / B(43, −17), with session ID `example-cal-23` and no participant contact. The development server serves it at `/demo-handoff-example.json`. This regenerable developer fixture is distinct from the current selection exported in the application; it does not bypass the application's mandatory startup registration or make a private handoff available.

| Field | Meaning |
| --- | --- |
| `sessionId`, `routeVersion` | Local demo identity and version. They are not canonical server project or route versions. |
| `snapshot` | A snapshot that passes the shared `Snapshot` Zod schema. Owners and parcels remain fictional; no negotiations, agreements, approvals or payments are fabricated. |
| `parcelAnalysis` | Per-parcel length, foundations, exact allocated upfront/rent cents, cap, pending status, fictional contacts, and display-role overlay. |
| `judgeRole` | One affected `parcelId`, original fictional owner, generic `displayAlias: "Judge participant"`, local opaque contact reference, and participant readiness. The entered participant alias is not exported. |
| `coordinateTransform` | Explicit, invented local-grid-to-WGS84 conversion described below. |
| `callPreparation` | Preparation status, selected role's proposed amounts, and `backendBindingRequired: true`, `contactRegistered: false`, `canStartCall: false`. |

The local `judgeRole.participantContactRef` is a correlation identifier. **It is not a registered dial destination.** It must not be submitted directly to the live call service. The host needs to register the private participant and obtain a server-owned contact reference.

The snapshot preserves `accessConsent: "unknown"` and `negotiationStatus: "pending"` from the fixture, and `readyToApprove: false`. Parcel cap or budget failures set `eligible: false` and `callPreparation.status: "review-required"`. The handoff's default USD 1,000,000 budget is a fictional fixture parameter, configurable through `createHandoff({ ..., budgetCents })`; it is not the user's approval of a real budget.

## Coordinate and money interpretation

The map uses local x/z tiles. To exercise the team's existing GeoJSON/meters contract, the exported snapshot uses an explicit synthetic transform:

- Origin: longitude **−120.5**, latitude **37.0**.
- Scale: **100 meters per tile**, invented for this adapter.
- x increases east; z increases south.
- Conversion: local equirectangular approximation at origin latitude, spherical Earth radius **6,371,008.8 m**.
- `lengthMeters = lengthTiles × 100`; `areaSqM = areaTiles × 100²`.
- Project endpoint points are the facilities' line connection terminals, matching the first and last exported line coordinates.

These are invented geographic positions, not actual California parcel boundaries. The adapter does not make the rendered tower dimensions or clearance assumptions real engineering measurements. Geometry transformation metadata lives outside the strict shared-contract objects.

All money is integer USD cents. Per-parcel compensation and full-horizon rent sum exactly to the selected route cost components. Span rounding is allocated deterministically. A pylon foundation can touch multiple parcels: per-parcel `towerCount` counts those touches; the route's pylon count is the unique count.

`monthlyRentEquivalentCents` is a rounded display equivalent. When `monthlyRentIsApproximate` is true, multiplying it by the horizon may differ by a few cents from `rentTotalCents`. The authoritative planning amount is `rentTotalCents`. Do not copy these estimates into accepted `NegotiationResult` terms: Pratham's agent must negotiate explicit monthly terms and the backend must recalculate cost and eligibility.

## Backend binding before a call

The shared API does not currently define contact-registration or map-snapshot-import endpoints. The host must implement those adapters; the map does not invent endpoints or send requests to an unknown service. The following example describes those required interfaces, rather than claiming they already exist:

```js
import { buildCallSessionRequest } from './apps/map-preview/src/handoff.js';

window.easygridDemo.setHandoffHandler(async ({ handoff, participant, signal }) => {
  // These host methods must be implemented by the team backend.
  const binding = await host.importMapFixture(handoff, { signal });
  signal.throwIfAborted();

  const registered = await host.registerDemoParticipant({
    projectId: binding.projectId,
    phoneE164: participant.phoneE164,
    alias: participant.alias,
    aiRoleplayConsent: participant.consent,
  }, { signal });
  signal.throwIfAborted();

  // Read the current server state after any import/registration mutations.
  const state = await host.getCurrentRouteBinding(binding.projectId, { signal });
  signal.throwIfAborted();
  // The host must verify this is still the imported route and the assigned parcel
  // is still included. Resolve local IDs to canonical IDs through the import mapping.
  host.assertCurrentHandoff(handoff, binding, state);

  const request = buildCallSessionRequest({
    projectId: state.projectId,
    expectedRevision: state.revision,
    parcelId: binding.parcelIds[handoff.judgeRole.parcelId],
    routeVersion: state.routeVersion,
    registeredContactRef: registered.contactRef,
    participantConsent: true,
    idempotencyKey: host.newCallActionId(),
  });

  // Stage for Pratham's explicit call action; do not dial from preparation alone.
  await host.stagePreparedCall(request, { signal });
});
```

At the explicit call action, recheck participant consent, the intended recipient, parcel inclusion, current revision and route version. Then submit the validated request through the shared `createCallSession` operation (`POST /api/v1/call-sessions`). Keep the same idempotency key for that action; an unknown outcome must not automatically trigger another call.

Aborting a browser request cannot undo a server mutation that already arrived. The host must reject stale versions and invalidate staged calls when the route or participant changes. Phone registration alone is never proof a call happened.

## Validation

Run from the repository root with Node 24:

```sh
npm ci --prefix packages/contracts --ignore-scripts
npm test --prefix apps/map-preview
```

`handoff.test.mjs` checks participant validation, redaction, single-role assignment, cost conservation, synthetic coordinates, cap/budget blocking and stale inputs. `handoff-contract.test.mjs` imports the actual shared Zod schemas and validates the snapshot and canonical `createCallSession` request. These checks do not prove a live backend import, real call, browser layout or GPU rendering.
