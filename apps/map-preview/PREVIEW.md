# Open the EasyGrid web preview

No Node.js, package installation or local server is required for the downloaded preview.

1. Sign in to GitHub with an account that can access the repository.
2. Open [PR #8](https://github.com/prathamsnehi/easygrid-calhacks-26/pull/8), then its latest successful **Map and parcel handoff** Actions run.
3. Download **easygrid-web-preview** from the run's **Artifacts** section and unzip it.
4. Open the extracted **index.html** in a desktop browser with WebGL enabled.

The ZIP includes this README, the self-contained page, synthetic parcel fixtures and a contact-redacted handoff example. Artifacts expire after 14 days; the source remains in GitHub. A successful run validates the map tests and package generation, not browser/GPU rendering on every device.

## Try the map

Enter a demo alias and a fictional phone number such as **+1 202-555-0147**, then tick the roleplay consent box and select **Start demo**. Use only fictional details for this offline review. This standalone page has no calling agent connected, so it does not send those details or place a call.

Place A (substation) and B (data center) on valid open sites. **Find open site** and **Place here** can help. After the analysis transition, inspect the transmission estimate and choose **Analyze affected parcels** to review owners and compensation. One-finger/mouse drag pans; two-finger or Shift-drag rotates; scroll/pinch zooms.

The preview contains the CAL-30 construction-price model and minimum 1.6-second analysis transition. **Agent call** remains disabled until the host integration is connected. Calls, agreements and payments are separate integration work.

## Build from source instead

Latest preview branch: `theo/cal-30-transmission-pricing-loading` (PR #8, not yet merged into `main`). In a fresh clone:

```sh
git clone --branch theo/cal-30-transmission-pricing-loading https://github.com/prathamsnehi/easygrid-calhacks-26.git
cd easygrid-calhacks-26
node apps/map-preview/build.mjs
```

Use Node 24. Open `apps/map-preview/dist/index.html`, or run `npm run dev --prefix apps/map-preview` and visit http://127.0.0.1:4177.
