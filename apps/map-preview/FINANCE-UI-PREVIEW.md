# EasyGrid finance UI review (CAL-36–39)

Open the normal **EasyGrid map UI first**. Complete fictional participant onboarding and place Substation (A) and Data Center (B). Select a transmission route, choose **Analyze affected parcels**, then open **Contracts, approvals & settlement** at the bottom of the existing Land & people panel.

Only the finance section of the existing map UI is authored in this draft PR. Theo's map experience stays the entry screen; there is **no separate financial website**.

This is a **UI fixture for demonstration**, not live settlement. Source figures are **map estimates, not negotiated/approved SpacetimeDB agreements**. Simulated signature/manager approval buttons never grant actual land consent. The UI contains contract preview/version and supersession, simulated 20/80 obligation workflow, two-month fee reconciliation, retry history, and read-only placeholder Hyphenate/Nessie sections. The latter are **NOT CONNECTED** and do not meet live sponsor integration requirements. CAL-29/41 own authoritative persistence and the shared connection.

To verify this exact branch without using a separate UI: GitHub Actions → latest `Map and parcel handoff` successful run → artifact `easygrid-web-preview` → unzip → open `index.html` in Chrome or Edge.
