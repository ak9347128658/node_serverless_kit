# Publishing node_serverless_kit to npm

This is the full maintainer guide for releasing **node_serverless_kit** to the public npm registry. For a short checklist, see [How_to_deploy.md](How_to_deploy.md).

| | |
|---|---|
| npm package | [`node_serverless_kit`](https://www.npmjs.com/package/node_serverless_kit) |
| CLI | `nskit` (alias `node_serverless_kit`) |
| Entry points | `node_serverless_kit`, `node_serverless_kit/testing`, `node_serverless_kit/api` |
| Repository | <https://github.com/ak9347128658/node_serverless_kit> |
| Author | Asif Khan |
| License | MIT |

There are two ways to publish:

1. **Automated (recommended):** push a `vX.Y.Z` tag. [`.github/workflows/release.yml`](../.github/workflows/release.yml) checks the version, runs all checks, publishes with provenance through npm **trusted publishing** (OIDC, no long-lived token), and creates a GitHub release from `CHANGELOG.md`.
2. **Manual:** `npm publish` from your machine. You need this once for the very first release, because npm only lets you configure a trusted publisher for a package that already exists.

> **Commands:** blocks are given for bash (Linux, macOS, Git Bash) and PowerShell. In Windows PowerShell 5.1, `&&` doesn't work: run commands one per line.

---

## 1. One-time setup

### 1.1 npm account and 2FA

1. Create an account at <https://www.npmjs.com/signup> and verify your email.
2. Turn on two-factor authentication: avatar → **Account** → **Two-Factor Authentication** → **Enable 2FA**. Choose **Authorization and writes** so every publish needs a second factor. Use a security key or an authenticator app, and store the recovery codes somewhere safe.
3. Optional but recommended: in **Account → Profile**, link your GitHub account.

### 1.2 Log in from the terminal

```bash
npm login                   # opens the browser (web login); completes 2FA there
npm whoami                  # prints your npm username
```

`npm login` stores a session token in your user `~/.npmrc` (`%USERPROFILE%\.npmrc` on Windows). Never commit an `.npmrc` that contains a token; the repository's `.gitignore` already ignores `.npmrc`.

Check that you are talking to the public registry:

```bash
npm config get registry     # must print https://registry.npmjs.org/
```

If it prints something else (a company mirror), publish with `--registry https://registry.npmjs.org/`.

### 1.3 Verify the package name

```bash
npm view node_serverless_kit
```

- `npm error code E404 ... Not Found` means the name is free (expected before the first release).
- If it prints package metadata, the name exists. After our first release that is us; before it, somebody else owns it and you must change `name` in `package.json` (and every doc and badge).

npm also rejects names that are too similar to existing packages (for example differing only by punctuation). The registry tells you at publish time with `E403 ... Package name too similar to existing package`.

---

## 2. Prepare the release

### 2.1 Pick the version

The project uses [Semantic Versioning](https://semver.org/):

| Change | Bump | Example |
|---|---|---|
| Bug fixes only | patch | `0.1.0` → `0.1.1` |
| New features, backwards compatible | minor | `0.1.1` → `0.2.0` |
| Breaking changes | major (minor while `0.x`) | `0.2.0` → `1.0.0` |
| Pre-release for testing | prerelease | `0.2.0-beta.0`, `0.2.0-rc.1` |

### 2.2 Bump the version in both places

The version lives in **two files that must match**: `package.json` and `src/version.ts` (`export const VERSION = "X.Y.Z"`, which is bundled into every deployment and shown by `nskit --version`). `npm version` only edits `package.json`, so don't let it create the commit and tag on its own:

```bash
npm version 0.2.0 --no-git-tag-version      # or: patch | minor | major | prerelease --preid beta
```

Then edit `src/version.ts` to the same value and check:

```bash
node scripts/check-version.mjs              # version 0.2.0 OK
```

`npm version` also updates `package-lock.json`; commit it together with the other files.

### 2.3 Update the changelog

In `CHANGELOG.md`, rename the `## [Unreleased]` content to a new section and leave an empty `Unreleased` above it:

```markdown
## [Unreleased]

## [0.2.0] - 2026-11-01

### Added
- ...
```

The release workflow copies this section into the GitHub release, so the heading must be exactly `## [X.Y.Z]`. Mention when users must run `nskit deploy` again to pick up runtime fixes (the runtime is bundled into each deployment).

### 2.4 Run every check

```bash
npm ci
npm run check               # typecheck + lint + tests + build (also runs automatically as prepublishOnly)
npm run validate:terraform  # optional locally (needs Terraform); CI runs it for all 10 providers
```

### 2.5 Review the tarball

```bash
npm pack --dry-run
```

The package is defined by the `files` field in `package.json` (there is no `.npmignore`). Expect only:

- `bin/nskit.js`
- `dist/` (ESM `.js`, CommonJS `.cjs`, `.d.ts` / `.d.cts`, source maps)
- `src/` (needed at deploy time: the runtime TypeScript sources are bundled into every function artifact)
- `README.md`, `LICENSE`, `CHANGELOG.md`, `package.json`

Anything else (`tests/`, `examples/`, `.nskit/`, `.env`, `coverage/`, `*.tgz`) means `files` is wrong: fix it before publishing. To inspect the real archive:

```bash
npm pack                    # writes node_serverless_kit-X.Y.Z.tgz
tar -tzf node_serverless_kit-*.tgz
```

You can also smoke-test the tarball in a scratch project:

```bash
mkdir /tmp/nskit-smoke && cd /tmp/nskit-smoke
npm init -y
npm install /path/to/node_serverless_kit-X.Y.Z.tgz
npx nskit --version
npx nskit init demo -p aws -t http && cd demo && npx nskit validate
```

### 2.6 Commit and tag

```bash
git add package.json package-lock.json src/version.ts CHANGELOG.md
git commit -m "chore(release): v0.2.0"
git tag -a v0.2.0 -m "v0.2.0"
```

---

## 3a. Publish with GitHub Actions (recommended)

### 3a.1 Configure trusted publishing (once per package)

Trusted publishing lets GitHub Actions publish through OpenID Connect: npm verifies a short-lived token issued for this repository and workflow, so no npm token is stored in GitHub. It needs **npm CLI >= 11.5.1** and **Node.js >= 22.14** in the job (the workflow runs Node 22 and installs `npm@latest`).

1. The package must already exist on npm, so do the first release manually ([section 3b](#3b-publish-manually)).
2. On npmjs.com open the package → **Settings** → **Trusted Publisher** → **GitHub Actions**, and enter:
   - **Organization or user:** `ak9347128658`
   - **Repository:** `node_serverless_kit`
   - **Workflow filename:** `release.yml` (file name only, not the path)
   - **Environment name:** `npm` (the workflow uses `environment: npm`; leave empty only if you remove that line)
3. Save. Optionally, under **Settings → Publishing access**, choose **Require two-factor authentication and disallow tokens**. Trusted publishing keeps working, while stolen tokens can no longer publish.
4. Optional: in GitHub **Settings → Environments → npm**, add required reviewers so a maintainer approves each publish.

The job grants itself `permissions: id-token: write` (OIDC) and `contents: write` (GitHub release). With trusted publishing, `npm publish` automatically generates [provenance](#provenance).

### 3a.2 Alternative: an `NPM_TOKEN` secret

If you can't use trusted publishing (or before it is configured):

1. On npmjs.com: avatar → **Access Tokens** → **Generate New Token** → **Granular Access Token**.
2. Name `node_serverless_kit-ci`, expiration as short as practical, **Packages and scopes: Read and write**, limited to `node_serverless_kit` (for the very first publish, "all packages" is needed because the package doesn't exist yet). Tick **Bypass two-factor authentication** so CI can publish without an OTP.
3. In GitHub: **Settings → Secrets and variables → Actions → New repository secret**, name `NPM_TOKEN`.

The workflow passes it as `NODE_AUTH_TOKEN`, which `actions/setup-node` writes into the job's `.npmrc`. When a trusted publisher is configured, npm prefers OIDC and the secret is unused (an empty or missing secret is fine). Delete the token once trusted publishing works.

### 3a.3 Push the tag

```bash
git push origin main
git push origin v0.2.0
```

The workflow then:

1. checks that the tag, `package.json` and `src/version.ts` agree (`node scripts/check-version.mjs --tag "$GITHUB_REF_NAME"`);
2. runs `npm ci`, `npm run check` and `npm pack --dry-run`;
3. runs `npm publish --provenance --access public` (skipped when the version is already on npm), with dist-tag `next` when the version contains a `-` (pre-release) and `latest` otherwise;
4. creates a GitHub release whose notes are the `## [X.Y.Z]` section of `CHANGELOG.md` (marked as pre-release for `-` versions).

Watch it under the repository's **Actions** tab. If it fails before the publish step, fix the problem, delete and recreate the tag (`git tag -d v0.2.0 && git push origin :refs/tags/v0.2.0`), and push again. If it failed after publishing, don't reuse the version: bump to the next patch.

---

## 3b. Publish manually

Required for the first release (`0.1.0`), and a fallback if CI is unavailable.

```bash
npm whoami                          # logged in as the right user?
node scripts/check-version.mjs      # versions agree
npm run check
npm pack --dry-run
npm publish --access public         # prepublishOnly runs `npm run check` again
```

`--access public` is also set through `publishConfig.access` in `package.json`; passing it explicitly doesn't hurt. With 2FA for writes, npm 11 opens a browser even when `npm whoami` already succeeds. Approve that page and wait. `--otp <code>` only works with an authenticator code. A `403` on `GET /-/v1/done` means that login died; see the troubleshooting table.

Then push the commit and tag (`git push origin main --follow-tags`). The release workflow runs on the tag, sees that this version is already on npm, skips the publish step and still creates the GitHub release from the CHANGELOG section.

### Provenance

Provenance is a signed statement, recorded in a public transparency log, that links the package to the exact commit and workflow that built it. npm shows it as a **Provenance** section and a check mark on the package page.

- `npm publish --provenance` only works from a supported CI provider (GitHub Actions or GitLab CI/CD on cloud-hosted runners) with an OIDC token. From a laptop it fails with `Automatic provenance generation not supported for provider: null`, so don't pass `--provenance` for manual publishes.
- With trusted publishing, provenance is generated automatically.
- The repository URL in `package.json` must match the GitHub repository that runs the workflow (`git+https://github.com/ak9347128658/node_serverless_kit.git`), or the provenance check fails with `E422`.

---

## 4. Dist-tags, pre-releases and beta channels

Every published version has dist-tags. `npm install node_serverless_kit` installs whatever `latest` points to.

```bash
npm version 0.3.0-beta.0 --no-git-tag-version     # then edit src/version.ts
npm publish --tag next                            # never publish a pre-release without --tag
npm install node_serverless_kit@next              # users opt in
```

Always pass `--tag` for pre-releases: without it the version is tagged `latest` and every user gets the beta. The release workflow uses `next` automatically for versions with a `-`.

Manage tags afterwards:

```bash
npm dist-tag ls node_serverless_kit
npm dist-tag add node_serverless_kit@0.3.0-beta.1 beta
npm dist-tag add node_serverless_kit@0.3.0 latest       # promote, or roll latest back to an older version
npm dist-tag rm node_serverless_kit beta
```

Rolling `latest` back to the previous good version is the fastest response to a broken release, followed by a fixed patch release.

---

## 5. Deprecate and unpublish

**Prefer deprecation.** It keeps installs working but prints a warning:

```bash
npm deprecate node_serverless_kit@0.2.0 "Broken AWS packaging, upgrade to 0.2.1"
npm deprecate node_serverless_kit@"< 0.2.1" "Upgrade to 0.2.1 or later"
npm deprecate node_serverless_kit@0.2.0 ""          # remove the deprecation
```

**Unpublishing** is restricted by npm's [unpublish policy](https://docs.npmjs.com/policies/unpublish):

- Within **72 hours** of publishing you can unpublish a version, as long as no other public package depends on it.
- After 72 hours, unpublishing is only allowed if **no public package depends on it**, it had fewer than **300 downloads in the last week**, and it has a **single owner**. Otherwise contact npm support.
- A version number can **never be reused**, even after unpublishing. Publish a new version instead.
- If you unpublish **every** version, nobody (including you) can publish the package name again for **24 hours**.

```bash
npm unpublish node_serverless_kit@0.2.0      # one version
```

Never unpublish to "fix" a release. Deprecate it and publish a patch.

---

## 6. Verify the release

```bash
npm view node_serverless_kit version          # newest version on latest
npm view node_serverless_kit dist-tags
npm view node_serverless_kit@0.2.0 dist.tarball
npx -p node_serverless_kit@latest nskit --version
npx node_serverless_kit@latest --version      # same CLI through the package-name bin
```

In a clean directory, confirm both module systems resolve:

```bash
npm init -y && npm install node_serverless_kit
node -e "console.log(require('node_serverless_kit').VERSION)"
node --input-type=module -e "import { VERSION } from 'node_serverless_kit'; console.log(VERSION)"
```

On <https://www.npmjs.com/package/node_serverless_kit>, check the README renders (images and links are absolute GitHub URLs), the version, the **Provenance** section (CI releases), and the file list under **Code**. Then check the GitHub release and that the README's npm badge shows the new version (it can take a few minutes to refresh).

Optionally verify signatures and provenance of installed packages:

```bash
npm audit signatures
```

---

## 7. Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `E403 Forbidden - GET https://registry.npmjs.org/-/v1/done` | Web login for the publish write did not finish. npm 11 returns `401` on `PUT` and opens a browser even when `npm whoami` works. A dropped connection (`ENOTFOUND`, `ECONNRESET`) makes the follow-up poll `403` | Approve the browser page and wait. Retry `npm publish --access public` on a stable connection. Or set a granular token with **Read and write** and **Bypass 2FA** in the user `.npmrc` |
| `E403 Forbidden ... You do not have permission to publish "node_serverless_kit"` | The name belongs to another account, or you are logged in as the wrong user | `npm whoami`; `npm owner ls node_serverless_kit`; ask an owner to run `npm owner add <you> node_serverless_kit` |
| `E403 ... Package name too similar to existing package` | npm's typosquatting protection | Choose another name |
| `E403 ... Two-factor authentication or granular access token with bypass 2fa enabled is required` | Publishing with a token that can't satisfy 2FA | Use a granular token with **Bypass 2FA**, or trusted publishing |
| `E403 ... You cannot publish over the previously published versions` | That version exists | Bump the version; versions are immutable |
| `E402 Payment Required ... You must sign up for private packages` | Publishing a scoped package (`@scope/name`) without public access | `npm publish --access public` (already in `publishConfig`) |
| `EOTP This operation requires a one-time password` | 2FA is on for writes | Re-run with `--otp <code>`, or complete the browser prompt. In CI use trusted publishing or a bypass-2FA token |
| `EPUBLISHCONFLICT` / `Cannot publish over existing version` | The version is already on npm (the release workflow skips publishing in that case; manual publishes don't) | Bump the version. Don't unpublish to free it: the number can't be reused anyway |
| `ENEEDAUTH This command requires you to be logged in` | No token for the registry | `npm login`; in CI check `registry-url` in `setup-node`, `id-token: write`, and the trusted publisher settings (owner, repo, workflow filename, environment) |
| `E404 Not Found - PUT https://registry.npmjs.org/node_serverless_kit` | Auth failed (npm returns 404 instead of 401/403 for some token problems), wrong registry, or an OIDC exchange that didn't match | `npm config get registry`; regenerate the token; re-check the trusted publisher fields match exactly |
| `E422 ... Error verifying sigstore provenance bundle` / repository mismatch | `repository.url` in `package.json` doesn't match the GitHub repo running the workflow | Fix `repository.url` |
| `Automatic provenance generation not supported for provider: null` | `--provenance` used outside CI | Drop `--provenance` for manual publishes |
| Trusted publishing ignored, falls back to token | npm older than 11.5.1 or Node older than 22.14 in the job | Keep the `npm install -g npm@latest` step and Node 22 |
| `check-version: tag vX does not match ...` in CI | Tag and files disagree | Fix the files or the tag, then re-tag |
| `prepublishOnly` fails | `npm run check` found a problem | Fix it; never publish with `--ignore-scripts` to skip checks |

## 8. Security notes

- Prefer trusted publishing; if you use tokens, make them granular, scoped to this package, short-lived, and delete them when no longer needed.
- Keep 2FA on your npm account and set the package to **Require two-factor authentication and disallow tokens** once trusted publishing works.
- Never commit `.npmrc` files that contain `_authToken`.
- Review `npm pack --dry-run` output for every release: the tarball must never include `.env`, `.nskit/` or Terraform state.
