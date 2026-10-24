# Transmission connection estimate

CAL-30 uses a synthetic 230 kV, single-circuit overhead connection. Prices are planning benchmarks, not a supplier quote or a current California project estimate. The total covers the transmission connection and its fictional land terms; it excludes substation electrical equipment, the data center, financing and taxes.

## Component basis

Source: [MISO MTEP24 Transmission Cost Estimation Guide, May 2024](https://cdn.misoenergy.org/20240501%20PSC%20Item%2004%20MISO%20Transmission%20Cost%20Estimation%20Guide%20for%20MTEP24632680.pdf), Tables 2.2-2, 2.2-11 and 2.2-14. Use the reported table values without an invented 2026 escalation or California multiplier.

- Each rendered intermediate tower receives a $128,393 installed running-angle tower allowance. This includes material, erection, hardware and foundation. Uniform pricing is a conservative simplification for ordinary towers, not a design for every angle or load case.
- Each of the two endpoint supports receives a $161,748 installed non-angle dead-end allowance. This is a support, not a complete substation connection bay. It is charged once per endpoint.
- Installed wire includes three ACSS 795 kcmil Drake phase conductors, one OPGW and one shield wire, with 4% sag/waste. The source components give approximately $76,055.12 per route km. The model rounds to 190,138 cents per 25 m tile before multiplying and rounding each span.

The wire expression, in USD per route km, is:

```text
[3 × (1,807 + 2,477 + 277) + (2,819 + 4,229) + (623 + 936)]
× 1.04 × 1,000 / 304.8
```

The three rendered phase lines do not multiply that bundle price again. Tower foundations are already included in the tower rate; agricultural pad clearing is a separate fictional land-use allowance.

## Total and rounding

Direct construction comprises installed wire, towers, endpoint supports and the existing fictional terrain/crossing/clearing allowances. Engineering and project management add 10% of direct construction. Contingency adds 30% of direct construction plus engineering. These are explicit demo planning choices, not a claim to implement MISO's entire capital-cost methodology.

```text
connection estimate = direct construction
                    + engineering / management
                    + construction contingency
                    + one-time land compensation
                    + 12 months of simulated rent
```

Engineering and contingency are rounded per graph edge or support to integer cents before search. Their displayed totals are sums of those rounded items; they can differ slightly from applying a percentage to the final route subtotal. Neither allowance applies to compensation or rent. Both endpoint allowances are added once, outside the shortest-path objective, because they are constant for every candidate. The displayed total and both handoff construction totals include them.

## Scale and scope

The shared horizontal scale is 25 m/tile. The map remains visually unchanged; its maximum 15-tile span represents 375 m. The WGS84 adapter version changes to `california-valley-synthetic-wgs84-v2`: distances are one quarter and areas one sixteenth of earlier v1 packets. Consumers must honor packet metadata. Tower heights, sag, clearance and foundation drawings remain stylized and are not engineering dimensions. Fictional parcel compensation rates remain per demo tile; they are not real acreage valuations.

The fixed fixture budget is $5,000,000 and remains configurable. It is not derived from a route, authorized spending or evidence of commercial eligibility. Existing handoff cap/budget checks remain enforced. CAL-30 still tracks filtering those constraints before route recommendation.

`cost-model.js` is the shared source for rates, allowances, scale and budget. UI summaries, route optimization, generated map examples and handoff totals consume it. Integration overrides are captured as `effectiveRates` and `rateOverrides` in route/handoff metadata rather than relabeled as default benchmark rates. The separate owner-handoff workflow samples retain their explicitly invented two-owner payment values.

The generated example at A=(-43,-17), B=(43,-17) has 6 intermediate towers, 2 endpoint supports and a 2.176 km route. Its connection estimate is $1,822,922.60, including $4,222.75 compensation and $620.67 comparison rent. Changing sites recalculates the actual counts, lengths, affected parcels and totals.
