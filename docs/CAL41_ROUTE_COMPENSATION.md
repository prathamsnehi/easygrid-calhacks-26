# Route impact and agreed compensation

This change uses the existing fictional map. It does not import surveyed parcels,
real buildings, agricultural GIS or live occupancy information.

## Route choices

- **Shortest connection** minimizes distance on the feasible support-site graph.
- **Lowest modeled cost** minimizes the existing modeled construction, land and
  rent costs.
- **Lower-impact alternative** prioritizes weighted human disturbance before
  terrain-adjusted modeled cost: cultivated-land corridor exposure, nearby homes and work areas,
  roads, and tower-pad disturbance. The same hard clearance, structure,
  foundation and refused-parcel constraints apply to every choice.

Human disturbance is a separate preference score, not an extra compensation
charge. Its geometry comes from the same synthetic terrain and activity objects
used to render the map. Activity buffers are demo preferences, not legal setbacks.
When all feasible routes have some exposure, the lower-impact route minimizes
that score on the declared graph; it does not claim zero impact or a global
geographic optimum.

An easement corridor can touch a parcel even when neither its priced centerline
nor a tower pad enters that parcel. The existing pricing model does not price
that corridor-only case. It remains **review required**, with negotiation and
payment blocked; a new lower-impact route must not silently treat it as a
zero-dollar approved parcel.

## One amount from negotiation to payment

The map's recommendation and maximum remain the original negotiation policy.
They must not be recalculated from an accepted offer. A saved successful result
can display a separate **Agreed compensation**, expressed in integer cents.
Pending, proposed, conditional, unsuccessful and review-required outcomes do not
establish an agreed amount.

A browser result is display evidence, not authority to pay. Contract preparation
sends an opaque negotiation reference and current map context. The server must
resolve committed negotiation state through an injected trusted adapter, verify
the exact session, route, participant, terms, version, policy and budget, and
derive the contract amount from that state. An absent resolver, mismatched
reference, stale result or out-of-policy amount must stop preparation rather than
fall back to the initial recommendation.

The canonical agreed cents flow through the normalized source, approved draft,
signature/version checks, full-payment obligation, provider request and ledger.
Changing the current agreement cannot silently reuse older signatures or bypass
an attempted payment. Provider amount restrictions must produce a clear rejection;
they must never round or substitute the approved amount.

## Single-landowner scope

The existing one-owner demonstration remains one contract and one full-payment
action. A scoped approval retains the original route and other owners' approval
states. It does not imply that pending owners agreed, enable their payments or
grant route-wide construction readiness. Legacy source identities remain unchanged
when the new scoped-approval metadata is absent.

## Integration boundary

The public saved-result subscription and the trusted server resolver are separate
interfaces. A connected voice/state service must supply the latter from its
authenticated committed state. The local development fixture exercises that
boundary explicitly in simulation; it is not evidence that a live call or bank
transfer occurred. CAL-33 and the wider CAL-41 deployment work remain separate.

The resolver must retain and verify the import's ID mapping. This adapter expects
the returned committed packet to use the original map's session, project, route,
parcel and owner IDs; changing a packet's `referenceBinding` label alone is not a
real import. The synthetic fixture deliberately uses the same IDs on both sides.
For a live external state store, the host must also make execution authorization
stable for the operation, for example with a transaction or lease. A fresh read
alone does not prove atomicity across a later external provider request.

Run the server from the complete repository with `packages/contracts`
dependencies installed and Node 22.18 or newer. The negotiated adapter imports
the shared TypeScript validators at runtime. Earlier app-only downloads do not
contain this new integration.

Validation evidence and the resulting draft PR are recorded on CAL-41.
