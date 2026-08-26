# GitHub supply-chain runbook

The repository treats GitHub settings as part of the production boundary. Versioned manifests in `infra/github/` require pull requests and both Node CI jobs on `main`, prevent release-tag deletion or force movement, allow only selected Actions pinned to full SHAs, and limit deployment environments to `main` or `v*` as appropriate.

## Apply the policy

Authenticate `gh` as the repository owner, then run from a clean released checkout:

```bash
./infra/github/configure.sh
```

The operation is convergent: it removes deployment refs not present in the versioned manifests, restores missing refs and fails if any residual drift remains. Dependabot proposes verified GitHub Actions SHA updates through pull requests; never replace a full SHA with a mobile major tag.

Releases are created only by pushing a stable `vX.Y.Z` tag connected to `main`. The workflow checks out the event SHA in every job and has no manual dispatch input. If a release job fails after the tag exists, use GitHub's **Re-run failed jobs** action; do not move or recreate the immutable tag.

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
- `release.yml` has no `workflow_dispatch` and every release checkout uses `github.sha`;
- `AWS_CANARY_ROLE_ARN` points to `widthwatch-canary`;
- a successful canary cannot call `cloudformation:UpdateStack` or `iam:PassRole`.
