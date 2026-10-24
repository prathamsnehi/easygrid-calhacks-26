# easygrid-calhacks-26

Transmission AI Agent for Cal Hacks 2026: routing → landowner negotiation → easement → simulated deposit and rent reconciliation.

The shared API contract, TypeScript client, validation policies and synthetic examples are in [`packages/contracts`](packages/contracts/README.md) (CAL-6).

```sh
cd packages/contracts
npm ci
npm run check
```

AI model API: **Claude**. Target shared backend: **SpacetimeDB**. Voice/telephony is a separate integration. This repository currently supplies the shared contract package; app/backend implementation is tracked separately in Linear.

- [API specification](packages/contracts/openapi.json)
- [Request/response examples](packages/contracts/examples/api-v1.json)
- [Happy-path snapshot](packages/contracts/examples/happy-path.json)
- [Failure and consistency examples](packages/contracts/examples/edge-cases.json)
- [Project and work ownership](https://linear.app/easygrid-calhacks-2026/project/transmission-ai-agent-9897ba9eb980/issues)

All fixtures use synthetic parties, illustrative parcels and mock settlement. No live calls, real signatures, payments or regulatory approvals are claimed.
