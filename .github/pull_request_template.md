## What and why

<!-- What does this change, and why? Link the issue: Fixes #123 -->

## Type

- [ ] Bug fix
- [ ] New feature / option
- [ ] Provider (new or changed)
- [ ] Docs / examples
- [ ] Refactor / tooling

## Checklist

- [ ] `npm run check` passes (typecheck, lint, tests, build)
- [ ] Tests added or updated (bug fixes include a regression test)
- [ ] Handler code stays portable; non-portable features live under a provider's `options:` and are documented
- [ ] `src/runtime/` and `src/index.ts` still have zero dependencies and no unguarded `node:*` / `Buffer` / `process`
- [ ] Generated Terraform verified with `npm run validate:terraform -- --provider <name>` (provider changes)
- [ ] Docs updated (`docs/`, provider page, README matrix if capabilities changed)
- [ ] Entry added under **Unreleased** in `CHANGELOG.md`

## Notes for reviewers

<!-- Failure modes, provider limits, anything you are unsure about. -->
