# CAL-28: shared setup workflow

## Local Cartesia package checks

Use Node.js 22 or newer. From the repository root:

```sh
cd services/cartesia
npm ci
npm test
npm run typecheck
npm run build
```

The tests mock provider responses; they do not demonstrate live provider connectivity. See [the Cartesia README](../services/cartesia/README.md) for configuration and usage. Keep actual configuration values in backend secret configuration or an ignored local environment file.

## Connect pull requests to Linear

1. Open Linear Settings → Integrations → GitHub.
2. Connect the repository to the intended Linear workspace.
3. Include the issue identifier in the branch name or pull-request title.
4. Use `Contributes to CAL-28` while setup acceptance criteria remain open.
5. Verify automatic linking in Linear; a manually attached URL alone does not demonstrate synchronization.
6. Configure the team's pull-request workflow rules if automatic status updates are desired.

Connecting GitHub and Linear separately to a coding assistant does not configure Linear's own GitHub integration.

## Completion evidence

Record the reviewed pull request, tested commit, commands and actual results in the issue. Keep contributor access checks in the team workspace.

Verify the intended integration branch separately from individual component branches. Provider requests, backend provisioning and live calling each need their own evidence before they are marked complete.
