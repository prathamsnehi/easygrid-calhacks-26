# Firebase Hosting (CAL-47)

The static frontend is deployed to https://easygrid-calhacks-26.web.app/ in Firebase project `easygrid-calhacks-26` (Spark plan). The alternative default domain is https://easygrid-calhacks-26.firebaseapp.com/.

## Automatic deployment

After the CAL-47 workflow is merged into `main`, a push to `main` affecting `apps/map-preview/**`, `packages/contracts/**`, `firebase.json`, `.firebaserc`, or the Hosting workflow starts `.github/workflows/firebase-hosting.yml`. Pull requests run validation without deployment access. The Actions UI also supports a manual run from `main`.

The workflow installs shared-schema test dependencies with `npm ci --ignore-scripts --prefix packages/contracts`, then runs `npm test --prefix apps/map-preview`. Tests build the standalone frontend. Only the resulting `apps/map-preview/dist/` artifact is deployed after validation succeeds. The deployment checks that the live index matches that artifact. Deployment jobs are serialized and skip an artifact when newer frontend, shared-contract, or Hosting configuration inputs already exist on `main`. Unrelated backend-only commits do not suppress a frontend deployment. HTML uses `Cache-Control: no-cache` so returning visitors revalidate the page.

GitHub authenticates with Workload Identity Federation and short-lived credentials; no service-account private key or Firebase refresh token belongs in GitHub secrets or the repository. The `github-actions` pool's `easygrid-frontend` provider trusts GitHub's OIDC issuer, restricted to repository ID `1431630045`, owner ID `82077507`, `refs/heads/main`, and this exact workflow path. The dedicated `github-hosting` service account has Firebase Hosting Admin and Service Usage Consumer roles on this project only. Its impersonation binding is restricted to that repository in this pool. Feature branches and pull requests cannot obtain deployment credentials.

The workflow is activated only when present on `main`; publishing a draft PR alone does not activate automatic live deployment. Its first successful deployment must be verified separately from a local CLI deployment.

## Local deployment

From the repository root, using an authorized Firebase CLI account:

```sh
npm ci --ignore-scripts --prefix packages/contracts
npm test --prefix apps/map-preview
firebase deploy --only hosting --project easygrid-calhacks-26
```

Hosting serves the built map at `/` and the separate contract demonstration page at `/contracts.html`. There is no SPA catch-all rewrite: unknown URLs and `/api/**` remain 404s, instead of returning HTML disguised as an API response.

## Backend boundary

This deployment serves static files only. Map planning, route calculation, fictional parcel fixtures, and participant registration run in the browser. Entered participant contacts remain in page memory according to the existing frontend policy.

`apps/map-preview/serve.mjs` and its `/api/contracts/**` routes are Node server code and are not deployed by Firebase Hosting. Contract approval, signing, and payment simulation that require those routes still require the local server or a separately deployed backend. The hosted standalone preview also has no calling agent configured; a host must explicitly attach the existing `window.easygridDemo` handlers. Do not describe the static site as a live voice, settlement, or SpacetimeDB integration. No provider secrets are embedded in the static bundle.

Node VM UI tests do not verify browser layout or GPU rendering. Record real browser verification separately.

## Initial validation evidence

The initial CLI deployment on October 24, 2026 (America/Los_Angeles) published the frontend from main baseline `22b5508`. All 252 map tests passed after the required dependency installation. The published index was downloaded and matched byte-for-byte with the tested build; `/` returned HTTP 200 with the configured no-cache header, and `/api/contracts/example` returned HTTP 404 as expected. Chrome displayed onboarding and the WebGL map with no captured warning/error console entries. This is a Hosting smoke check, not full browser/GPU or live backend integration verification.
