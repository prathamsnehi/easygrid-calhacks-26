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

Provisioning owner: Pratham Snehi. Pratham confirmed the Cartesia account,
outbound number and existing live-test setup are ready. The Cartesia README
records the key, number, voice and Managed Agent provisioning steps. These
account-level checks do not establish the later integrated calling workflow.

## Claude access smoke test

Use the [Claude setup README](../services/claude-api/README.md) to configure the
local credential and reproduce the successful `READY` smoke test. This folder
currently provides access-test instructions and an environment template; the
reusable AI service is implementation work for CAL-33/CAL-34.

## SpacetimeDB: Maincloud with repo-local tooling

Use **Maincloud shared development** for team integration. Keep the native CLI
inside this repository instead of installing it globally or changing shell
configuration. An optional local database can be used for isolated experiments.

The `spacetimedb` npm package is the application SDK/module library. It does not
replace the CLI used to publish modules and generate bindings. The service
scaffold pins SDK `2.13.0`; align backend/module dependencies and generated
bindings during CAL-29 implementation.

The [SpacetimeDB service scaffold](../services/spacetimedb/README.md) contains a
credential/configuration template in `services/spacetimedb/.env.example` and a
helper for configuring the module's generated connection builder. Copy the
template to that directory's ignored `.env` and fill in the actual database name.

### Install the CLI inside the repository

Run these commands from the repository root. The root `.gitignore` keeps
downloaded tools and local configuration private while allowing the small CLI
wrapper to be committed. Keep these rules in place before installing, since
the installation includes local login credentials:

```gitignore
**/.tools/*
!/.tools/spacetime-cli
```

Install using the official installer and its custom-root option:

```sh
mkdir -p .tools/spacetime

curl -sSf https://install.spacetimedb.com |
  sh -s -- --root-dir "$PWD/.tools/spacetime"
```

The executable is `.tools/spacetime/spacetime`. The installer may suggest adding
it to `PATH`; that is unnecessary when using the repository wrapper below.

### Verify and log in

From the repository root:

```sh
./.tools/spacetime-cli --version
./.tools/spacetime-cli login
./.tools/spacetime-cli login show
```

Use the same GitHub or Google account for CLI login and the Maincloud dashboard.
`login show` confirms the current identity; omit `--token` when recording or
sharing the result.

### CLI wrapper

`.tools/spacetime-cli` forwards every argument to the installed CLI and supplies
the absolute `--root-dir` automatically. Its installation path is resolved from
the script's location, so it also works when invoked from a service directory:

```sh
# From services/cartesia:
../../.tools/spacetime-cli --version
```

The wrapper uses only the root `.tools/spacetime/` installation. Run the installer
from the repository root so tools and configuration stay outside the service
packages. The original service-local installation has been moved here with its
existing configuration; no service-local fallback is used.

The wrapper preserves your current working directory, so module paths and other
relative CLI arguments keep their normal meaning. It does not install the CLI
or log in automatically; if the executable is missing, it prints a setup hint
and exits with status 127. It forwards the CLI's exit status and uses `exec` so
signals reach the CLI directly. Commit the executable wrapper and ignore rules;
keep the actual `.tools/spacetime/` installation and credentials untracked.

When invoking the underlying binary directly, still pass `--root-dir` before
the subcommand. Prefer the wrapper for day-to-day commands.

Record the verified CLI version for teammates and CI. Keep the module library,
generated bindings, client SDK, and deployment target versions compatible.
The relocated local installation was verified as CLI/module-library version
`2.13.0` using the wrapper. Pratham subsequently confirmed CLI login as recorded
below. Database deployment still requires separate verification.

### Shared development target and first deployment

- Provider: SpacetimeDB Maincloud.
- Host URI: `https://maincloud.spacetimedb.com`.
- Deployment owner: Pratham Snehi. Individual Maincloud collaborator access for
  Theo and Stella will be configured and verified when the project is available.
- Database name: choose and record a distinctive available development name;
  `easygrid-calhacks26-dev-pratham` is a suggestion, not a provisioned database.
- Account energy: **100,000**, reported available by Pratham on October 24, 2026.
  This is a reported balance at setup time, not a verified subscription tier or
  a measured workload-capacity estimate.
- Plan: Free was the initial recommendation; the actual account tier has not
  been recorded. Do not infer the tier from the energy balance alone.

### Account readiness checkpoint — October 24, 2026

| Item | Recorded status |
| --- | --- |
| Development target | Shared SpacetimeDB Maincloud |
| Deployment owner | Pratham Snehi |
| CLI / reported library | `2.13.0` / `2.13.0` |
| Service npm SDK | Pinned to `2.13.0` |
| CLI authentication | Confirmed by Pratham's supplied `login show` output: logged-in identity present |
| Account energy | 100,000 available, user-reported |
| Database name | `easygrid-calhacks26-dev-pratham` remains a proposal, pending first publish and availability |
| Database deployment | Pending CAL-29's initial module publish |
| Maincloud collaborator access | Pending project setup and verification for Theo and Stella |

The login check was run from the repository's `.tools/` directory:

```sh
./spacetime-cli login show
```

From the repository root, the equivalent command is
`./.tools/spacetime-cli login show`. The confirmation establishes CLI
authentication; it does not establish a published database, generated bindings,
or authorized application access. CLI credentials stay in the ignored
`.tools/spacetime/` installation; the backend's optional application identity
token is configured separately in `services/spacetimedb/.env`.

### First module publish

CAL-28 prepares access, tooling, and documented connection settings. The first
module publish creates the database and overlaps with CAL-29's initial scaffold.
Once the module exists, replace both quoted placeholders below and run from the
repository root:

```sh
./.tools/spacetime-cli publish "YOUR_DATABASE_NAME" \
  --server maincloud \
  --module-path "PATH_TO_MODULE"
```

Record the actual database name, database identity, dashboard URL, deployed
commit, and collaborator-access verification after publishing. Keep deployment
tokens private. Use a separate database for future production; independently
published databases do not automatically share application state.

References: [Node.js quickstart](https://spacetimedb.com/docs/quickstarts/nodejs/),
[Maincloud deployment](https://spacetimedb.com/docs/how-to/deploy/maincloud/),
[official installer implementation](https://github.com/clockworklabs/SpacetimeDB/blob/master/crates/update/src/cli/self_install.rs).

## Provider-unavailable behavior

These are planned implementation requirements. Automatic runtime fallback modes
are not yet implemented. CAL-28 documents the policy; CAL-29, CAL-33, and CAL-34
implement and verify the behavior described below.

| Failure | Required behavior | Implementation owner |
| --- | --- | --- |
| Cartesia cannot start a call | Show the failure. Allow the operator to explicitly select a deterministic simulated call scenario, labeled “Simulation — no live call placed.” | CAL-33 |
| Cartesia request times out after submission and acceptance is uncertain | Keep the attempt pending/unknown. Reconcile its provider status before permitting another live call. | CAL-33 |
| Claude transcript analysis fails | Keep the real outcome pending/review-required. An operator-selected fixture demonstration must remain isolated and labeled simulated. | CAL-34 |
| SpacetimeDB is unreachable | Show shared state as unavailable and block state-changing actions. Any standalone fixture demonstration must state that its data is not persisted. | CAL-29 |

Simulation must be explicitly selected and must never overwrite an uncertain
live outcome. Fixture paths, selection commands, and runtime verification will
be documented when the owning issues implement them.

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
