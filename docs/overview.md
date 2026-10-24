EasyGrid — Transmission Land Acquisition & Financial Settlement Agent

Project Overview & Execution Plan · v1

Event: Cal Hacks 2026 · October 23–25, 2026
Team: Theo · Pratham · Stella
Status: Approved for publication and subsequent implementation. Recreate this Linear project’s documents and issues, then proceed with backend implementation.

1. Product goal

EasyGrid automatically recommends a transmission route connecting a substation to a data center, then coordinates landowner negotiations, easement agreements and simulated settlement.

The user selects both facility sites on a California-inspired 3D pixel map. The agent considers terrain, construction cost, land compensation, recurring fees and crossing constraints to automatically recommend one route and explain its decision.

A judge participates in a real phone call as a landowner. Their response changes the route, cost or next action. Once negotiations are complete, the workflow proceeds to agreements and simulated settlement.

The central demonstration is a judge’s real conversation changing the map and project plan.

Agreement: Site selection → route recommendation → negotiation → contracts and approval → simulated completion → payments and reconciliation.

Refusal: Exclude the parcel → replan → negotiate with other fictional owners → contracts and approval → simulated completion → payments and reconciliation.

2. Map and site selection

The fictional world includes farmland, orchards, a river, hills, developed areas and restricted zones. The current map foundation contains 120 × 96 tiles, with three facility clearings on each riverbank. Facility clearings and negotiated parcels are separate concepts.

The user:

Selects substation site A within a zone assumed to connect to the existing grid.

Selects data-center site B within a supported construction area.

Receives validation of each facility’s full footprint against terrain, occupancy and placement rules.

Sees the recommended route, illustrative towers and affected parcels.

One world model drives rendering, route geometry, parcel intersections and cost calculations. Affected land includes both tower sites and parcels crossed by overhead wires.

3. Route recommendation and costs

The agent evaluates possible routes internally and displays one recommendation. When negotiated conditions change, it recalculates and explains the difference from the previous route.

Factor

Treatment

Distance

Base construction cost increases with line length.

Hills and slope

Difficult terrain adds construction cost.

River crossings

Only designated spans are allowed, with additional cost.

Developed or restricted areas

Configured exclusion zones are avoided.

Land use

Compensation and monthly fees depend on tower count, wire length and land type.

Negotiations

Agreed terms affect costs; refused parcels are excluded.

One-time compensation per parcel combines a rate per tower and a rate per unit of wire length within that parcel, adjusted for land-use impact. Both components apply when a parcel contains towers and overhead wires.

Monthly usage fees are calculated separately using recurring rates for continued land use. Rates and land-type adjustments are configurable demo assumptions.

Total route cost = construction cost + total one-time compensation + recurring fees over the same comparison period.

The 20% contract payment and 80% completion payment divide the same compensation amount; they are not added twice. The previously discussed $2,000, $8,000 and $100 monthly amounts were examples, not fixed requirements.

All rates and restrictions are simulated. The interface uses the label “Simulation Constraint Checks.” Actual regulatory research and legal eligibility assessments are future scope.

4. Owner assignment and automatic negotiation

A simulated land registry contains fictional owners, baseline compensation and negotiation conditions.

After calculating the first route, the system randomly selects one affected negotiable parcel and associates the judge’s name and contact information with its owner role. The interface identifies this role, and a call begins only after explicit consent.

Participant identity and contact information do not influence routing or cost scores.

Claude supports negotiation and structured outcome extraction. Voice and telephone connectivity use a separate integration. Outcomes include accepted, refused, counteroffer, pending and review required.

The agent negotiates automatically within defined limits:

Compare one-time compensation and recurring fees over the same period.

Consider the total project budget and alternative-route cost before accepting or counteroffering.

Replan when agreement is difficult or a bypass is more economical.

Keep ambiguous conditions and unknown outcomes pending or under review.

Treat terms as accepted only after explicit owner confirmation.

Once the judge refuses, exclude that parcel. Find another route and conduct simulated negotiations with other fictional owners. Do not reassign the judge to another parcel or call them again as a different owner.

Label fictional negotiations as simulations. If no route satisfies the constraints and budget, explain the failure and stop.

5. Contracts, completion and simulated payments

Negotiations must be complete for every parcel on the final route before proceeding to contracts.

Generate versioned demo easements from confirmed terms.

Capture simulated signatures.

Obtain manager approval for the current route and complete agreement package.

Simulate payment of 20% of one-time compensation at the contract stage.

Use the “Simulate Completion” button to mark construction complete.

Simulate payment of the remaining 80%.

Begin separate monthly usage fees after completion.

The completion button is enabled only after contracts, simulated signatures and manager approval are complete. Advance the demo clock through two monthly periods to show payment and reconciliation, including a matched case and a discrepancy.

Route, term or contract changes invalidate affected approvals. Payment amounts come from approved contracts. Repeated requests or button clicks must not create duplicate payments.

Real fund transfers, legally executed easements and government submissions are outside this demo.

6. Starting a new demo

Keep the result screen visible after settlement. The operator starts another run with “New Demo.”

Clear participant information and facility selections.

Reset routes, negotiations, contracts, approvals, completion and simulated payment state.

Reload the base map and fictional owners.

Separate the new run from the previous one so late call results cannot modify the new session.

7. Architecture and ownership

SpacetimeDB is the planned authoritative shared state store. Claude handles negotiation and structured outcomes. Explicit application rules control routing, costs, limits, approvals and payments.

All workstreams use one shared data/API contract. Extend the existing contract for facility placement, map coordinates, simulation constraints, completion state and the 20%/80% payment structure. Credentials and real participant contact information remain server-side.

Owner

Responsibility

Theo

3D map and site selection, automatic routing, parcel analysis, costs, simulation constraint checks and replanning

Pratham

Development setup and SpacetimeDB integration, Claude/voice connectivity, automatic negotiation, structured outcomes and integrated QA

Stella

Agreements, simulated signatures, approval/completion/payment workflow, monthly fees, reconciliation and demo assets

All three owners review shared-contract changes.

8. Delivery plan and acceptance criteria

Stage

Target

Exit condition

Foundation

Immediately after plan approval

Rebuilt Linear plan, consistent map/API model and runnable setup

Working components

October 24 · 13:00 PDT

Independent demonstrations of routing, negotiation and agreement/payment workflows

Integration and QA

October 24 · 20:00 PDT

Refusal and replanning connect through contracts, completion and settlement

Demo freeze

October 25 · 08:00 PDT

Stable demo, backup recording, README and submission assets

These are internal targets. Rebaseline them when publishing and verify the organizer’s actual submission deadline separately.

P0 acceptance criteria

Displayed routes, crossed parcels and charged parcels agree.

One route recommendation and its rationale are shown.

Refusals and counteroffers update routes and costs correctly.

Every parcel on the final route satisfies negotiation, contract and approval requirements.

The 20%/80% payments and post-completion monthly fees match the contracts.

Stale approvals, duplicate payments and late events from previous demos are blocked.

State survives refresh, and three consecutive end-to-end runs pass.

Real calls and simulated negotiations, signatures and payments are clearly distinguished.

Additional data, richer negotiation review and provider test-mode integrations follow only after P0 passes. Actual regulatory research and real-project deployment remain future scope.

9. Linear rebuild and next steps

As authorized by the user, delete and recreate the existing documents and issues belonging to this project. Replace old issue references and reconnect existing PRs to the new issues.

Preserve the existing Linear project and workspace, GitHub repository and code. Reuse the shared API package and map preview, updating them to support the confirmed requirements.

Execution sequence: publish the approved English and Korean documents and rebuild Linear issues → update the shared contract and implement SpacetimeDB → integrate and test.
