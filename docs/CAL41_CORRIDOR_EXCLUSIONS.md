# Partial corridor overlap in the demo

The demo excludes a parcel from compensation and approval scope when the surrounding
corridor touches it but its wire centerline length is at most the existing 1e-7-tile
geometry tolerance, its tower count is zero and its foundation area is zero.
This supersedes the earlier corridor-only pricing-review gate documented in
CAL41_ROUTE_COMPENSATION.md. It is a demo scope choice, not a property valuation or
a statement that a real easement is unnecessary.

The full geometric route and parcel analysis remain available for map highlighting
and routing constraints. Such rows display **Partial corridor overlap** and
**Excluded**, never an accepted zero-dollar offer. They are excluded from pending
owner counts, the shared negotiation snapshot's parcel IDs, owner-handoff parcels,
contract sources and payment recipients. The shared schemas are unchanged.

The frontend and server reconstruct this scope from the same geometry. A browser
cannot opt a priced parcel out by setting an exclusion flag. Recommendations, caps,
route costs and exact accepted cents for directly affected parcels are unchanged.
Budget checks, refused access, negotiation review, required signatures and payment
reconciliation locks remain in place. Routing still respects the full physical
corridor, including refused parcels and obstacles.

A participant already bound to a parcel that becomes corridor-only keeps the
original identity, but cannot receive another call or contract for that excluded
parcel. New role assignment chooses a directly affected parcel. Existing signed
documents and payment attempts are not migrated or rewritten: the changed proposal
binding requires a newly prepared current package, with existing payment locks
preserved.
