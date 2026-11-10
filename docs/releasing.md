# Releasing `dsh-api-cost` to npm — maintainer runbook

Status: **2.3.0 is live on npm**, published 2026-11-10 by
`.github/workflows/npm-publish.yml` from the `v2.3.0` GitHub Release with SLSA
provenance (`_npmUser: GitHub Actions`). The name had been bootstrapped earlier the
same day as npm's `0.0.0-stage` reservation stub; §4 records how. The registry needed
about 80 seconds to make the first real version readable after `npm publish` returned
(`Your package is being processed and may take a few minutes to become available`),
which is why the workflow now polls the registry for up to five minutes and skips the
publish steps when the version is already live.

Two facts from the bootstrap that older runbooks miss:

- **npm now requires 2FA — or a granular access token with "Bypass two-factor
  authentication" checked — to create and publish packages.** A token without that
  flag fails in CI with `EOTP`. Trusted publishing (OIDC) sidesteps the token; it is
  now configured for this package and was validated by the 2.3.0 release (§5).
- **A brand-new package's first publish is staged by the registry**: the public page
  appears as a `0.0.0-stage` stub and the real version waits in the *Staged Packages*
  tab (or `npm stage list` / `npm stage approve <stage-id>` on npm ≥ 11.15). Always
  confirm with `npm view dsh-api-cost versions` after a publish; §7 and the workflow's
  final step do.

The npm install line in the READMEs — `dsh plugin --profile web add dsh-api-cost` —
and the npm version badge now resolve against the published package.

| File | Role |
| --- | --- |
| `.github/workflows/npm-publish.yml` | The single publish workflow: one job, one package, one publish. |
| `package.json` | `publishConfig.access` is `"public"`; provenance is deliberately **not** in `publishConfig` (see §2.3). |
| `docs/releasing.md` | This runbook. |

---

## 1. The release path in one page

A release is a **published GitHub Release** whose tag is `vX.Y.Z` and whose version is
exactly the `version` field in `package.json`.

```
bump version + commit (+ tag vX.Y.Z + push) → publish the GitHub Release
                                            → npm-publish.yml runs
                                            → npm gets vX.Y.Z with provenance
```

The workflow only starts on a release if it exists on the repository's **default
branch** (GitHub's rule for `release: published`) — keep `main` up to date. A manual
`workflow_dispatch` run may select another branch, but a real publish from it
publishes that branch, so use `main`.

`release: types: [published]` fires when a release is published, not when it is saved
as a draft, and not when only a tag is pushed. Creating the release is therefore the
trigger step; the tag itself does nothing on its own.

## 2. What the workflow does

One job on `ubuntu-latest`, `timeout-minutes: 30`:

| Step | Purpose |
| --- | --- |
| `actions/checkout@v4` (`fetch-depth: 0`) | Full history for the release-tag check. |
| `pnpm/action-setup@v4` (`version: 11.7.0`) | Same pnpm as `test.yml`. |
| `actions/setup-node@v4` (`node-version: 24`, `registry-url: https://registry.npmjs.org`) | Node 24; npm configured against the public registry. No `cache:` key: a release build stays cache-free. |
| `pnpm install --frozen-lockfile --ignore-scripts` | Reproducible install; no install scripts run. |
| `pnpm typecheck`, `pnpm test`, `pnpm bench` | The same gates as CI. `pnpm test` rebuilds `dist/`. |
| `git diff --exit-code -- dist` | `dist/` is committed and deterministic; a publish never ships a stale bundle. |
| release tag ↔ version check | Release events only: `vX.Y.Z` (one leading `v` stripped) must equal `package.json` `version`. A mismatch fails the run before anything is packed. |
| check whether the version is already live | Reads the registry before publishing; if the version is already there the publish steps are **skipped**, so a re-run after a late-availability failure stays safe. |
| `pnpm pack --pack-destination "$RUNNER_TEMP/npm-pack"` | The exact tarball npm will publish. |
| `actions/upload-artifact@v4` (`npm-pack`, 14-day retention) | Audit trail: the packed tarball is downloadable from the run. |
| publish / dry run | See §2.1. |
| `npm view dsh-api-cost@<version>` (real publish only) | Polls up to **five minutes** for the version to become readable. A first real publish can be staged, and even a direct publish is not readable for a while ("Your package is being processed…"); a failure here is actionable, not silent (§7). |

Permissions are `contents: read` and `id-token: write`; the latter is required both
for npm provenance and for OIDC trusted publishing. Concurrency is one group
(`npm-publish`) with `cancel-in-progress: false`: a second release **queues** behind
the running one instead of cancelling it, because a publish must never be cut in
half.

### 2.1 Authentication paths

The workflow selects the path from the presence of the `NPM_TOKEN` repository
secret. The secret is never read in an `if:` directly (Actions does not allow the
`secrets` context there); a job-level env boolean `HAS_NPM_TOKEN` carries the answer.

| Condition | Step that runs | Command | Provenance |
| --- | --- | --- | --- |
| `NPM_TOKEN` secret set | *Publish with NPM_TOKEN* | `npm publish --provenance --access public` (token in `NODE_AUTH_TOKEN`) | Produced by the explicit `--provenance` flag (the workflow has `id-token: write`). |
| `NPM_TOKEN` secret absent | *Publish with OIDC trusted publishing* | `npm publish --access public`, relying on the npm OIDC trusted publisher configured on npmjs.com | npm generates it automatically for trusted publishing. |
| `workflow_dispatch` with `dry-run: true` (the default) | *Dry run (rehearsal)* | `npm publish --dry-run --access public` | — nothing is uploaded. |

The token path exists for packages that do not exist on the registry yet (and as a
fallback). `dsh-api-cost` exists on npm, and its trusted publisher is configured and
was validated by the 2.3.0 release, so **trusted publishing** (§5) is the path future
releases use — no token secret needed. If you do use `NPM_TOKEN`, create it with
**Bypass two-factor authentication** checked: npm now requires 2FA or a bypass token
for every create/publish, and a token without that flag fails in CI with `EOTP`.

Both publish steps run `npm` (not `pnpm publish`), from the repository root, against
`https://registry.npmjs.org`, with the default `latest` dist-tag. `--access public`
is explicit even though the package is unscoped: the published visibility is a
release decision, not a default.

### 2.2 The dry-run path

`workflow_dispatch` takes one boolean input, `dry-run`, defaulting to `true`. With
the default, everything above runs and the last step calls
`npm publish --dry-run --access public` instead of publishing: npm prints the exact
file list, size, shasum and integrity that a real publish would use, and nothing is
uploaded. It needs no credentials. Unchecking `dry-run` on a manual dispatch performs
a real publish (§6).

Because `setup-node` with `registry-url` writes
`//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` into the runner `.npmrc`, the
dry-run and OIDC steps set `NODE_AUTH_TOKEN: ''` and delete that config line first, so
npm never interpolates an undefined token and never mistakes the placeholder for real
credentials. That is a runner-side concern only; it is not a credential.

### 2.3 Why `publishConfig` has only `access`

`package.json` carries exactly `"publishConfig": { "access": "public" }`. Putting
`"provenance": true` in `publishConfig` was deliberately avoided: a local
`npm publish` from a maintainer's machine has no OIDC identity, so it would fail.
Provenance is requested where it is actually available — the `--provenance` flag on
the token path in CI, and npm's automatic generation on the OIDC path.

## 3. A normal release

The release version `X.Y.Z` must be semver, greater than the published version, and
contain no `-rc`/`-beta` suffix: the workflow publishes under the default `latest`
dist-tag, so a pre-release version would take `latest` (the workflow does not manage
dist-tags).

```sh
git checkout main
git pull

# 1. Bump the version in package.json (and any docs that describe the release).
# 2. Rebuild and commit the committed artifacts.
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
git status                      # expect only the intended changes, dist included

git add -A
git commit -m "Release vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main
git push origin vX.Y.Z

# 3. Create and publish the GitHub Release from the existing tag — this is the trigger.
gh release create vX.Y.Z --title "vX.Y.Z" --generate-notes
#    or: Releases → Draft a new release → choose tag vX.Y.Z → Publish release
```

Checklist:

1. `pnpm check` is green locally and `git diff --exit-code -- dist` is clean after
   `pnpm build`. The tag must point at a commit whose `package.json` says `X.Y.Z`;
   the workflow re-checks this and fails on `v1.2.3` vs `1.2.4`.
2. Do not mark the release as *pre-release* unless a dist-tag policy is added first.
3. Watch the run: Actions → **npm-publish** → the run for the tag. The first publish
   step to appear tells you which auth path ran (*Publish with NPM_TOKEN* or *Publish
   with OIDC trusted publishing*).
4. Stay on the run page: the *Upload the packed tarball* step links the `npm-pack`
   artifact for the audit trail. If a step **before** a publish fails, fix it and
   re-run the jobs — nothing was uploaded yet. A published version number is
   immutable: if the publish itself succeeded and something later needs fixing, bump
   the version; never try to republish the same one.

## 4. Bootstrap state (already done, 2026-11-10)

The name was reserved interactively, because npm does not allow an unattended first
publish:

1. The maintainer published a minimal `0.0.0` placeholder from a real terminal and
   approved npm's web-auth 2FA prompt in the browser.
2. The registry created the public `0.0.0-stage` placeholder stub and staged the first
   version, as it does for a brand-new package. That placeholder version was approved,
   then withdrawn to remove scratch files, leaving only the `0.0.0-stage` stub.
3. Net effect: the package exists on npm (owner `coffrabbit`), its package settings
   and *Trusted publishing* page are available, and **no real release is live**.

If you ever need to bootstrap a *new* package name again, the recipe is:

- Publish interactively from a TTY with 2FA (what happened here), or create a
  granular token with **Bypass two-factor authentication** checked and use it from CI
  as `NPM_TOKEN`.
- Expect the `0.0.0-stage` stub and possibly a staged first version; approve it in
  npmjs.com → *Staged Packages* (or `npm stage approve <stage-id>`) before treating
  the publish as live.
- Publish only the real release as `X.Y.Z`, and keep scratch files out of the
  tarball — the `files` whitelist in `package.json` does that for the real package.

## 5. OIDC trusted publishing (configured and validated)

2.3.0 was published through OIDC trusted publishing: the workflow took the *Publish
with OIDC trusted publishing* step (no token, no secret), and npm generated the
provenance attestation automatically. This section records the configuration and what
to check if it ever has to be re-created.

Prerequisites, all true for this repository: the package exists on npm; the repository
is public (provenance is generated for public packages from public repositories); the
job runs on a GitHub-hosted runner (trusted publishing does not support self-hosted
runners); the workflow has `permissions.id-token: write`; and `package.json`
`repository.url` exactly matches the GitHub repository
(`git+https://github.com/NIRVANA-APOC/dsh-api-cost.git`). Trusted publishing also needs
npm CLI **≥ 11.5.1**; Node 24's bundled npm satisfies this (the workflow prints the
version at the start of each run).

The trusted publisher configured on npmjs.com → **Packages → dsh-api-cost → Settings →
Trusted publishing** is a GitHub Actions relationship with:

- Organization or user: `NIRVANA-APOC`
- Repository: `dsh-api-cost`
- Workflow filename: `npm-publish.yml` (the file name only, with the `.yml`
  extension — not a path and not the workflow's display name)
- Environment name: **blank**
- Allowed actions: allow **`npm publish`**

To (re-)create it, use that form or
`npm trust github dsh-api-cost --file npm-publish.yml --repo NIRVANA-APOC/dsh-api-cost --allow-publish -y`
(2FA required). Up to 10 trusted publishers per package are allowed; an existing
connection cannot be edited, only deleted and recreated. A newly created configuration
expires if it does not complete a successful publish within **2 days**, so create it
when a release is ready.

After a first OIDC success, harden the package: npmjs.com → package **Settings →
Publishing access** → *Require two-factor authentication and disallow tokens* (trusted
publishers keep working; this only disables long-lived tokens). If an `NPM_TOKEN`
secret was ever added, delete it from the repository — until it is gone the token path
takes precedence and the OIDC configuration is never exercised — and revoke the token
on npmjs.com. If the OIDC publish fails with `ENEEDAUTH`, re-check the fields above for
exact case and spelling, that `id-token: write` is in the workflow, and that the runner
is GitHub-hosted.

## 6. Rehearsing with the dry-run dispatch

Use this after any change to the workflow, the package's files list or the release
process — no release, tag or secret required, and no network publish.

1. Push the workflow change to `main` (the dispatch button only lists workflows that
   exist on the default branch).
2. Actions → **npm-publish** → *Run workflow* → branch `main` → leave the
   `dry-run` checkbox **checked** (the default) → *Run workflow*.
3. Expect: install, typecheck, test, bench, the `dist` assertion, `pnpm pack`, the
   `npm-pack` artifact, and a green *Dry run (rehearsal)* step whose log contains
   `Publishing to https://registry.npmjs.org/ ... (dry-run)` and a file list. No
   *Publish* step runs. A `warn publish This command requires you to be logged in`
   line is expected in the dry-run step: the rehearsal deliberately has no
   credential and uploads nothing.
4. The rehearsal is the place to catch a broken gate, a stale `dist` or a wrong
   version check — before a tag exists and before anything is uploaded. Real publishes
   are append-only; never republish a version that already exists.

## 7. Verifying a publish

```sh
npm view dsh-api-cost version                          # latest; 2.3.0 as of 2026-11-10
npm view dsh-api-cost@X.Y.Z dist.integrity             # sha512-... integrity of the tarball
npm view dsh-api-cost@X.Y.Z dist.tarball               # the exact tarball URL
```

2.3.0 is live: `npm view dsh-api-cost version` answers `2.3.0`, and
`npm view dsh-api-cost versions` lists the bootstrap stub `0.0.0-stage` plus `2.3.0`.

- **Registry processing delay**: `npm publish` can return success while printing
  `Your package is being processed and may take a few minutes to become available.`
  The 2.3.0 publish took about 80 seconds to become readable. The workflow polls for
  up to five minutes; if its check still fails, re-run the failed job — the preflight
  step sees the version once it is readable and **skips the publish steps**, so the
  re-run cannot double-publish.
- **Staged first publish**: a brand-new package's first version can be staged. If
  `npm view dsh-api-cost versions` never lists the version after a publish that
  reported success, open npmjs.com → *Staged Packages* (or `npm stage list` /
  `npm stage approve <stage-id>` on npm ≥ 11.15) and approve the version with 2FA,
  then re-check. The workflow's final verification step fails instead of reporting a
  false success.

- **Contents**: `npm view dsh-api-cost@X.Y.Z dist.unpackedSize` is informational; the
  authoritative file list is the *Dry run* / `pnpm pack` output in the workflow log
  and the `npm-pack` artifact (§8).
- **Integrity**: compare `dist.integrity` (base64 SHA-512 after the `sha512-`
  prefix) with the tarball you downloaded from the run:
  `openssl dgst -sha512 -binary dsh-api-cost-X.Y.Z.tgz | openssl base64 -A`.
  They must be identical; that is what binds the artifact to the registry entry.
- **Provenance**: open <https://www.npmjs.com/package/dsh-api-cost> and use the
  *Provenance* section/link for the published version; it names this repository, the
  workflow file and the source commit. From a project that installed the package,
  `npm audit signatures` verifies registry signatures and the provenance attestation.
- **Which auth path ran**: the step names in the workflow log. The OIDC path has no
  token step at all; the token path does not validate any trusted publisher.

## 8. What the tarball contains

`files` in `package.json` is the whitelist; npm additionally includes `package.json`,
`README*` and `LICENSE`:

| Path | What it is |
| --- | --- |
| `dist/index.js`, `dist/client.js`, `dist/build-meta.json` | Prebuilt host bundle, lazy browser factory, build metadata. |
| `dist/types/**` | `.d.ts` declarations for host, client, pricing, shared contracts. |
| `cordis.patch.yml`, `icon.svg`, `locale/*.json` | Bundle patch, plugin icon, UI dictionaries. |
| `README.md`, `README.en.md`, `LICENSE`, `package.json` | Docs and manifest (required by npm). |

`src/`, `test/`, `scripts/`, `docs/` and the workflows are **not** published:
everything needed at install time is prebuilt, so installing the package never runs
a compiler or a build script. To inspect locally without publishing:

```sh
pnpm pack --pack-destination "$TMPDIR"        # or: npm publish --dry-run --access public
tar -tzf "$TMPDIR"/dsh-api-cost-*.tgz
```

## 9. Failure modes and what to do

| Symptom | Cause and fix |
| --- | --- |
| `release tag 'vX.Y.Z' does not match package.json version '...'` | The tag and the committed version disagree. Fix `package.json`, or move/recreate the tag and release on the right commit. Do not edit the version inside the workflow. |
| `git diff --exit-code -- dist` fails | `dist/` was not rebuilt (or was edited by hand). Run `pnpm build`, review the diff, commit `dist/` with the release. |
| `Unable to authenticate` / `ENEEDAUTH` on the OIDC step | No trusted publisher matches this run, or the token step was expected. Re-check `NIRVANA-APOC` / `dsh-api-cost` / `npm-publish.yml` (exact, case-sensitive), the `id-token: write` permission, and that the runner is GitHub-hosted. |
| `ENEEDAUTH` on the token step | `NPM_TOKEN` is missing, expired, revoked or read-only, or belongs to a user without publish rights to the package. Recreate a granular token with read/write packages and update the secret. |
| `403 Forbidden` / `cannot publish over previously published versions` | The version already exists on npm. Publishing is append-only: bump the version; never rewrite history. |
| The workflow did not start on the release | The workflow file is missing from the default branch, the release was a draft, or the event was a tag push rather than a published release. |
| *Verify the version is live on npm* fails although the publish step succeeded | The registry is still processing the upload (2.3.0 took ~80 s) or it staged the version. Wait a minute and re-run the failed job: the preflight skips publishing when the version is already live. If the version was staged, approve it in npmjs.com → *Staged Packages* (2FA) first. |
| A run was queued behind another | Expected: `concurrency` uses one group with `cancel-in-progress: false`. Let the queued run start rather than cancelling the in-flight one. |
| Provenance missing on the npm page | The OIDC path needs a public package from a public repository; the token path needs the `--provenance` flag (the workflow passes it) and `id-token: write`. Private repositories get no provenance. |
| npm CLI too old for trusted publishing | Trusted publishing needs npm ≥ 11.5.1. Node 24's bundled npm is new enough; the workflow prints the npm version at the start of every run. |
