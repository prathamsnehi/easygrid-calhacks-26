# easygrid-calhacks-26

Transmission AI Agent for Cal Hacks 2026: routing → landowner negotiation → easement → simulated deposit and rent reconciliation.

The repository contains the [shared API contract and TypeScript client](packages/contracts/README.md) (CAL-6), and the [interactive map planner](apps/map-preview/README.md) (CAL-7/CAL-8/CAL-23). The planner supports A/B placement, transmission route comparison, affected-parcel analysis and a consented user roleplay handoff for Pratham's voice integration.

From the repository root, use Node 24 (also used by the map CI):

```sh
npm ci --ignore-scripts --prefix packages/contracts
npm run check --prefix packages/contracts
npm run build --prefix apps/map-preview
npm test --prefix apps/map-preview
npm run dev --prefix apps/map-preview
```

The map is a standalone HTML/CSS/JavaScript frontend using vendored Three.js and a deterministic route solver. The generated `apps/map-preview/dist/index.html` works offline; the development server serves it at `http://127.0.0.1:4177`. Contract dependencies are needed for integration validation tests, not by the generated preview.

Begin on **Start demo** by entering the participant's name and phone number and confirming explicit consent to an AI roleplay demo call. US 10-digit numbers receive `+1` automatically; explicit international country codes are preserved. Valid registration unlocks A/B placement and routing. Place A and B, select a route, then choose **Analyze affected parcels**. The analysis shows affected owners, line and pylon impacts, and route-specific compensation and rent. **Agent call** sends the selected route and private user contact to a registered calling-agent handler; it is disabled in the standalone preview until that agent is connected. The interface has no JSON download action. Exactly one affected parcel always carries the registered participant's fictional owner role; the participant does not enter their details again in the analysis screen.

The participant's name, phone number and call consent stay in page memory; the public integration packet redacts personal details. **Edit participant** returns to the start screen and pauses planning and routing until registration is validated again, while preserving the endpoints. Reset, reload and leaving the page clear participant details and require registration again. **Start demo** does not contact the host or start a call. Only **Agent call** invokes the registered calling-agent handler; accepting that request does not prove that a phone connected.

See [Pratham's handoff guide](docs/PRATHAM_HANDOFF.md) for the version 2 map packet and host integration. A voice backend still needs to import the fixture, return canonical IDs/revisions, register the participant privately and implement the call action. The map's declared synthetic coordinate adapter is for contract interoperability, not real property coordinates.

AI model API: **Claude**. Target shared backend: **SpacetimeDB**. Voice/telephony is a separate integration. Development is tracked through [Linear](https://linear.app/easygrid-calhacks-2026/project/transmission-ai-agent-9897ba9eb980/issues); follow the issue, branch, validation and PR workflow in [AGENTS.md](AGENTS.md).

- [API specification](packages/contracts/openapi.json)
- [Request/response examples](packages/contracts/examples/api-v1.json)
- [Happy-path snapshot](packages/contracts/examples/happy-path.json)
- [Failure and consistency examples](packages/contracts/examples/edge-cases.json)
- [Project and work ownership](https://linear.app/easygrid-calhacks-2026/project/transmission-ai-agent-9897ba9eb980/issues)

All product UI text is English. Fixtures use synthetic parties, illustrative parcels and mock settlement. No live calls, real signatures, payments or regulatory approvals are claimed.
