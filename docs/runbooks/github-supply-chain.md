# GitHub supply-chain runbook

The repository treats GitHub settings as part of the production boundary. Versioned manifests in `infra/github/` require pull requests and both Node CI jobs on `main`, prevent release-tag deletion or force movement, allow only selected Actions pinned to full SHAs, and limit deployment environments to `main` or `v*` as appropriate.

## Apply the policy

Authenticate `gh` as the repository owner, then run from a clean released checkout:

```bash
./infra/github/configure.sh
```

The operation is convergent: it removes deployment refs not present in the versioned manifests, restores missing refs and fails if any residual drift remains. Dependabot proposes verified GitHub Actions SHA updates through pull requests; never replace a full SHA with a mobile major tag.

Releases normally start by pushing a stable `vX.Y.Z` tag connected to `main`. Before any production credentials are obtained, the release contract requires it to be the highest stable tag reachable from `origin/main` and requires `X.Y.Z` to match every package manifest and lockfile entry plus OpenAPI and landing metadata. Every job checks out and validates that exact immutable tag. If a release job fails after the tag exists, first use GitHub's **Re-run failed jobs** action. If GitHub loses the run before creating jobs and native rerun remains unavailable, manually dispatch `release.yml` from `main` with the existing tag. The same validation and idempotent publication path runs against the tag, never the mutable dispatch commit. The workflow graph itself comes from protected `main`, which remains part of the trusted computing base. Do not use recovery for rollback, and never move or recreate the tag.

## Environment boundaries

- `production` admits only `main` and `v*`. Application deploys and releases use its short-lived mutation roles.
- `monitoring` admits only `main`. The scheduled canary uses `AWS_CANARY_ROLE_ARN`, whose AWS policy can only describe `widthwatch-scanner-switch`.
- Emergency switch runs are dispatched from the latest immutable release tag. Disable reads no application or alerting secret; enable additionally verifies the expected confirmed email on both SNS topics.

GitHub deployment branch policies cannot select workflow filenames. OIDC trust binds each AWS role to its environment subject; workflow permissions, immutable refs and the distinct canary role provide the remaining boundary.

## Verify

```bash
gh api repos/damianociarla/widthwatch/actions/permissions
gh api repos/damianociarla/widthwatch/rulesets
gh api repos/damianociarla/widthwatch/environments/production
gh api repos/damianociarla/widthwatch/environments/production/deployment-branch-policies
gh api repos/damianociarla/widthwatch/environments/monitoring
gh api repos/damianociarla/widthwatch/environments/monitoring/deployment-branch-policies
```

Acceptance criteria:

- `allowed_actions=selected` and `sha_pinning_required=true`;
- active rulesets named `Protect main`, `Authorize release tag creation` and `Keep release tags immutable`;
- `main` requires `verify (22)` and `verify (24)` through a pull request;
- production policies contain branch `main` and tag `v*` only;
- monitoring contains branch `main` only;
- `release.yml` requires an explicit `release_tag` for recovery dispatches and every release checkout uses that validated tag;
- the release-ref gate rejects any tag that differs from package, lockfile, OpenAPI or JSON-LD versions;
- the scanner control-plane upgrade completes with a verified digest before application deployment;
- the scanner switch role can read only the installed scanner template for transactional rollback, while the application deploy role remains read-only for that stack;
- `AWS_CANARY_ROLE_ARN` points to `widthwatch-canary`;
- a successful canary cannot call `cloudformation:UpdateStack` or `iam:PassRole`.
