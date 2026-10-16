# How to release node-serverless-kit to npm (checklist)

Short version of [PUBLISHING_TO_NPM.md](PUBLISHING_TO_NPM.md). After a release anyone can run:

```bash
npm install node-serverless-kit          # or: npm install -D node-serverless-kit
npx nskit --version
```

| | |
|---|---|
| npm package | `node-serverless-kit` |
| CLI | `nskit` (alias `node-serverless-kit`) |
| Version files | `package.json` and `src/version.ts` (must match) |
| Author | Asif Khan @ Kavion.ai |

> Replace `X.Y.Z` with the release version. The first release is `0.1.0`, which is already set in both version files.
>
> Windows PowerShell 5.1 has no `&&`: run the PowerShell lines one at a time.

---

## 0. One-time setup

- [ ] npm account with 2FA (**Authorization and writes**): <https://www.npmjs.com/signup>
- [ ] Logged in: `npm login`, then `npm whoami`
- [ ] Registry is public npm: `npm config get registry` prints `https://registry.npmjs.org/`
- [ ] Name free (first release only): `npm view node-serverless-kit` returns `E404`
- [ ] After the first release: configure the **trusted publisher** on npmjs.com (package → Settings → Trusted Publisher → GitHub Actions: user `ak9347128658`, repo `node_serverless_kit`, workflow `release.yml`, environment `npm`). Details: [PUBLISHING_TO_NPM.md, section 3a](PUBLISHING_TO_NPM.md#3a-publish-with-github-actions-recommended).

## 1. Prepare

- [ ] On `main`, up to date, clean working tree
- [ ] Bump the version (skip for `0.1.0`)
- [ ] Edit `src/version.ts` to the same version
- [ ] Move the **Unreleased** notes in `CHANGELOG.md` to `## [X.Y.Z] - YYYY-MM-DD`

bash:

```bash
git checkout main && git pull
npm version X.Y.Z --no-git-tag-version
# edit src/version.ts: export const VERSION = "X.Y.Z";
node scripts/check-version.mjs
```

PowerShell:

```powershell
git checkout main
git pull
npm version X.Y.Z --no-git-tag-version
$text = (Get-Content -Raw src\version.ts) -replace 'VERSION = ".*"', 'VERSION = "X.Y.Z"'
[IO.File]::WriteAllText("$PWD\src\version.ts", $text)    # UTF-8 without BOM, keeps LF endings
node scripts/check-version.mjs
```

## 2. Check

- [ ] All checks pass
- [ ] Tarball contains only `bin/`, `dist/`, `src/`, `README.md`, `LICENSE`, `CHANGELOG.md`, `package.json`

bash / PowerShell (same commands):

```bash
npm ci
npm run check
npm pack --dry-run
npm run validate:terraform        # optional, needs Terraform; CI runs it
```

## 3. Commit and tag

bash:

```bash
git add package.json package-lock.json src/version.ts CHANGELOG.md
git commit -m "chore(release): vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
```

PowerShell:

```powershell
git add package.json package-lock.json src/version.ts CHANGELOG.md
git commit -m "chore(release): vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
```

## 4a. First release (0.1.0): publish manually

The package must exist on npm before a trusted publisher can be configured.

```bash
npm whoami
npm publish --access public       # asks for your 2FA code; or add --otp 123456
git push origin main --follow-tags
```

The tag push starts the release workflow. It sees that `0.1.0` is already on npm, skips "Publish to npm", and still creates the GitHub release from the CHANGELOG section. Then configure the trusted publisher (step 0).

## 4b. Every later release: push the tag

```bash
git push origin main
git push origin vX.Y.Z
```

GitHub Actions checks the version, runs `npm run check`, publishes with provenance (`latest`, or `next` for versions like `0.3.0-beta.0`) and creates the GitHub release.

## 5. Verify

```bash
npm view node-serverless-kit version
npm view node-serverless-kit dist-tags
npx -p node-serverless-kit@latest nskit --version
```

Check <https://www.npmjs.com/package/node-serverless-kit> (README, version, Provenance) and the GitHub release.

## Quick troubleshooting

| Problem | Fix |
|---|---|
| `EOTP` | Add `--otp <code>` or finish the browser prompt |
| `E403` / not allowed to publish | `npm whoami`; you must be an owner (`npm owner ls node-serverless-kit`) |
| `EPUBLISHCONFLICT` / cannot publish over existing version | Bump the version; numbers can't be reused |
| `ENEEDAUTH` / `E404` on PUT in CI | Check the trusted publisher fields (repo, `release.yml`, environment `npm`) or the `NPM_TOKEN` secret |
| `check-version: ... does not match` | Make `package.json`, `src/version.ts` and the tag agree |
| Broken release | `npm dist-tag add node-serverless-kit@<previous> latest`, then `npm deprecate node-serverless-kit@X.Y.Z "..."` and ship a patch |

Full table: [PUBLISHING_TO_NPM.md, section 7](PUBLISHING_TO_NPM.md#7-troubleshooting).
