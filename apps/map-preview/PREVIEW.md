# Open the EasyGrid web preview

Use the local server for contracts, signatures and the Nessie demo. A downloaded
HTML page can display the map, but cannot run the contract API by itself.

## Run the complete demo

Use Node 24 and run from the repository root:

```sh
npm run dev --prefix apps/map-preview
```

Open http://127.0.0.1:4177/ for the map, or
http://127.0.0.1:4177/contracts.html for the independent contract example.
`EASYGRID_PREVIEW_PORT` selects a different port. The default provider is local
simulation; that mode makes no Nessie request.

For the configured Nessie demo, run from `apps/map-preview`:

```sh
node server/nessie-setup.mjs --check
node build.mjs
node --env-file=.env.nessie serve.mjs
```

The private configuration must already contain the verified payer and recipient
mappings and explicitly enable the intended sandbox action. Setup covers one
payer and 26 fictional recipients; all 26 were provisioned and verified during
the October 25 integration. Do not copy private configuration, mappings or
ledgers into an artifact. See [Nessie setup](../../docs/NESSIE_SETUP.md) for the
operator commands and recovery rules. Only one server may own the Nessie ledger
directory at a time.

Nessie currently creates a **sandbox record**, not a verified payment to the
landowner. Its deployed create/readback shape has no receiving-account field.
The record-only flow keeps the approved full amount and contract reference, but
does not mark compensation paid, post a payment journal or start construction.
All current route agreements must still have both simulated signatures, followed
by a separate explicit record action. Signing alone creates no record.

Use an approved whole-dollar amount for this demo: Amelia's map agreement is
$1,144, and the standalone Willow Creek agreement is $12,000. Current Nessie
behavior truncates fractional dollar amounts, so the app blocks them before
submission rather than rounding the contract. Exact amount and reference must
match the provider readback before the record is shown as verified.

A previous pending or unknown attempt remains locked. Use the status/reconciliation
action; do not delete a ledger, change an obligation ID, or click repeatedly to
force another request. A verified record is still not evidence of account-to-account
settlement.

## Download the map-only preview

No Node.js, package installation or local server is required to view this map-only
artifact.

1. Sign in to GitHub with an account that can access the repository.
2. Open [Map and parcel handoff runs on main](https://github.com/prathamsnehi/easygrid-calhacks-26/actions/workflows/map-preview.yml?query=branch%3Amain), then the latest successful run. For an unmerged change, use that PR's successful run instead.
3. Download **easygrid-web-preview** from the run's **Artifacts** section and unzip it.
4. Open the extracted **index.html** in a desktop browser with WebGL enabled.

The ZIP includes this README, the self-contained page, synthetic parcel fixtures and a contact-redacted handoff example. Artifacts expire after 14 days; the source remains in GitHub. A successful run validates the map tests and package generation, not browser/GPU rendering on every device.

## Try the map

Enter a demo alias and a fictional phone number such as **+1 202-555-0147**, then tick the roleplay consent box and select **Start demo**. Use only fictional details for this offline review. This standalone page has no calling agent connected, so it does not send those details or place a call.

Place A (substation) and B (data center) on valid open sites. **Find open site** and **Place here** can help. After the analysis transition, inspect the transmission estimate and choose **Analyze affected parcels** to review owners and compensation. One-finger/mouse drag pans; two-finger or Shift-drag rotates; scroll/pinch zooms.

The preview contains the CAL-30 construction-price model and minimum 1.6-second
analysis transition. **Agent call** remains disabled until the host integration
is connected. In the server-backed demo, **Simulate refusal** retains the earlier
route faded beside the bold replacement route and unlocks **Continue to contract
& settlement** after the replacement terms are prepared. The demo assumes owner
acceptance; it does not place a call.

## Build from source instead

Use the integrated `main` branch. In a fresh clone:

```sh
git clone --branch main https://github.com/prathamsnehi/easygrid-calhacks-26.git
cd easygrid-calhacks-26
node apps/map-preview/build.mjs
```

Use Node 24. Open `apps/map-preview/dist/index.html`, or run `npm run dev --prefix apps/map-preview` and visit http://127.0.0.1:4177.
