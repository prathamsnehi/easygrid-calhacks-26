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
```

Use the same GitHub or Google account for CLI login and the Maincloud dashboard.

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
`2.13.0` using the wrapper. Login and database deployment require separate
verification.

### Shared development target and first deployment

- Provider: SpacetimeDB Maincloud.
- Host URI: `https://maincloud.spacetimedb.com`.
- Deployment owner: Pratham, with individual collaborator access for Theo and Stella.
- Database name: choose and record a distinctive available development name;
  `easygrid-calhacks26-dev-pratham` is a suggestion, not a provisioned database.
- Plan: start with Free and review current limits before changing plans.

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
