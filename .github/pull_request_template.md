## What and why

<!-- What does this change, and what problem does it solve? Link the issue if there is one. -->

## How it was tested

<!-- Commands you ran, and the setup for anything manual (same machine, SSH, reverse link, WSL). -->

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run test:e2e` passes (if the extension, client or CLI changed)
- [ ] Protocol changes: schema edited first, `npm run gen:types` run, fixture added under `test/fixtures/`, versioning rules in ADR 0001 followed
- [ ] ADR / README updated if behaviour or a decision changed
- [ ] No tokens, personal hostnames or home paths in code, fixtures or docs
