# ci

Reusable GitHub Actions workflows for `skarzi/*` repositories. Call one with
`uses: skarzi/ci/.github/workflows/<name>.yml@v1`. Other workflows in
`.github/workflows/` are internal to this repo.

| Workflow | Purpose |
| :--- | :--- |
| [`dependabot-auto-merge.yml`](#dependabot-auto-merge) | Approve and auto-merge matching Dependabot PRs. |

## Dependabot auto-merge

### What it does

`.github/workflows/dependabot-auto-merge.yml` runs only when the PR author is
`dependabot[bot]`. It validates `merge-method`, compares Dependabot metadata
(`dependabot/fetch-metadata`) with the filters and, on a match, approves the
PR (unless approved) and runs `gh pr merge --auto --<merge-method>`.

### Usage

```yaml
---
name: Auto-merge Dependabot development dependency PRs
"on": pull_request_target
permissions:
  contents: write
  pull-requests: write

jobs:
  dependabot:
    uses: skarzi/ci/.github/workflows/dependabot-auto-merge.yml@v1
    with:
      merge-method: squash
      dependency-type: direct:development
```

`pull_request` works as the trigger too. `@v1` exists only after the first
release (see [Releases](#releases)).

If you lint with zizmor, it reports two findings on this example:

- `unpinned-uses`: `@v1` is not a hash. Pin a commit hash, or allow tag pins
  for your own actions in `.github/zizmor.yml` (the key is a pattern:
  `"skarzi/ci"` without `/*` does not match):

  ```yaml
  ---
  rules:
    unpinned-uses:
      config:
        policies:
          "skarzi/*": ref-pin
  ```

- `dangerous-triggers`: `pull_request_target`. The workflow never checks out
  PR code. Suppress with `# zizmor: ignore[dangerous-triggers]` and a
  justification, or use `pull_request`.

### Inputs

Filters: empty matches anything, non-empty must equal exactly, all are
ANDed. To match every Dependabot PR set `dependency-type: ""`.

| Name | Default | Description |
| :--- | :--- | :--- |
| `merge-method` | `squash` | `squash`, `rebase` or `merge`. Anything else fails fast. |
| `dependency-type` | `direct:development` | Only match this type (`direct:production`, `direct:development`, `indirect`). |
| `update-type` | `""` | Only match this update type (for example `version-update:semver-major`). |

### Outputs

`merge-status`: `true` matched and auto-merge requested, `false` no match,
empty job skipped (author is not Dependabot).

### Prerequisites

In the GitHub UI of the caller repository:

1. Settings > General > Pull Requests > enable "Allow auto-merge".
2. Settings > Actions > General > Workflow permissions > enable "Allow GitHub
   Actions to create and approve pull requests".
3. Protect the base branch (branch protection or ruleset) with required
   status checks. Without unmet requirements `gh pr merge --auto` merges at
   once, even while CI is pending or failing. GitHub Free private
   repositories have no branch protection, rulesets or auto-merge (all
   public-only on Free, per GitHub docs), so matching Dependabot PRs merge
   at once there.
4. Caller `permissions` must grant `contents: write` and
   `pull-requests: write`. A reusable workflow cannot widen permissions, and
   the call fails with `startup_failure` when the default token lacks the
   scopes, always the case for Dependabot `pull_request` runs. Always set
   them.

Also: the caller `env:` does not propagate (use `with:`), and `skarzi/ci`
must be public for public callers (a private one is usable only by the
owner's other private repositories, Settings > Actions > General > Access).
This repo calls the workflow for its own Dependabot PRs, so the same applies
here; the required check is the `lint` job of `ci.yml`.

## Releases

Callers pin the floating major tag `@v1`, backed by semver tags `v1.x.y`.
Never use `@main`.

`make release -- (major|minor|patch)?` (default `patch`) tags HEAD of `main`
as the next `vX.Y.Z`, force-moves `vX` and pushes both atomically. It needs a
clean tree, `main` in sync with `origin/main` and a confirmation. The first
release is `make release -- major` (`v1.0.0`).

It is manual: `GITHUB_TOKEN` cannot push refs touching
`.github/workflows/*`, so a release workflow needs a GitHub App token or PAT.

## Development

Requires [mise](https://mise.jdx.dev). `make install` installs tools,
dependencies and git hooks. `make help` lists the stages, for example
`make lint-fix` and `make test`. Commits follow Conventional Commits
(commitlint hook).
