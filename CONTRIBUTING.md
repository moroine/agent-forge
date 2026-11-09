# Contributing to agent-forge

Thanks for helping. For setup and daily use, see [README.md](README.md); for
the host playbook, see [ansible/README.md](ansible/README.md). Security
issues go through [SECURITY.md](SECURITY.md), not public issues.

## Pull requests

`main` is protected and the maintainer merges.

- Without write access to the repository: fork it, push a branch to your fork
  and open a pull request against `main`.
- With write access: keep pushing `agent/<task>` branches to the repository
  (`forge ship` does this, and needs write access).

## Commits

- Use conventional prefixes: `feat:`, `fix:`, `chore:`, `docs:`, `test:`.
  Messages are in English or French.
- Every commit must be signed (GPG or SSH, shown as "Verified" by GitHub).
  A pull request with one unsigned commit cannot be merged, squash included.
  To set signing up, follow GitHub's guide to
  [signing commits](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits).
- To re-sign a branch before pushing again:
  `git rebase --force-rebase --gpg-sign <base>`, then push your own branch
  with `git push --force-with-lease`. `<base>` is the branch your work
  started from: `origin/main`, or `upstream/main` from a fork.

## Running the tests

```
npm ci
npm test
npm run check
npm run test:ansible
```

`ansible-lint ansible/` is also run in CI. The integration tests
(`FORGE_INTEGRATION=1 npm run test:integration`) and
`ansible/tests/vm-test.sh` need a disposable Incus host and are not run in CI;
see "Developing agent-forge" in [README.md](README.md).

## Secret scanning hook

Install [Betterleaks](https://github.com/betterleaks/betterleaks) 1.x with
your package manager (`brew install betterleaks`, `dnf install betterleaks`)
and check `betterleaks version`. Then install the pre-commit hook once per
clone:

```
npm run hooks:install
```

The hook scans staged changes and blocks the commit on a finding, printing the
file, rule, line and fingerprint of each one (never the secret). If
Betterleaks is missing or is not 1.x, it says so and lets the commit through.
CI runs the same scan on the commits a pull request adds, merge commits
included (job `secrets`), so the hook is a convenience: `git commit
--no-verify` skips it, CI does not.

To update the hook, run `npm run hooks:install` again from a checkout of `main`.
If a different hook is already installed, replace it with
`npm run hooks:install -- --force` (the `--` is needed for npm to pass the
flag on).

To see a finding yourself, run this from the repository root:

```
betterleaks git --pre-commit --staged --redact --report-format json --report-path - .
```

Never run Betterleaks with `--validation` or `-v`: `--validation` sends what
looks like a secret to the live API of its issuer, and `-v` is `--verbose` in
1.x (it prints findings in clear) and becomes `--validate` in 2.x.

For a false positive, add its `Fingerprint` to `.betterleaksignore` at the
repository root: one fingerprint per line, each with a comment saying why it
is not a secret. The format is `<path>:<rule>:<line>` for the pre-commit hook
(for example `docs/example.md:github-pat:12`) and
`<commit>:<path>:<rule>:<line>` for a commit scanned by CI. Inline
`gitleaks:allow` and `betterleaks:allow` comments are ignored
(`--ignore-gitleaks-allow`): the fingerprint is the only way to suppress a
finding.

`npm run secrets:triage` does this for you, one finding at a time. Without
arguments it scans the staged changes, as the hook does; with
`npm run secrets:triage -- <base> <head>` it scans the commits `<base>..<head>`,
as CI does (CI prints the command with its range). For each finding not yet
ignored, it shows the flagged lines and asks why they are not a secret: a
reason appends that comment and the fingerprint to `.betterleaksignore`, an
empty answer keeps the finding. Review the result with
`git diff -- .betterleaksignore` before committing it. The flagged lines are
shown in clear (control characters removed): run it in your own terminal,
never through an agent, whose transcript would receive a real secret.

Changes to `.github/`, `.githooks/`, `.betterleaksignore`, `betterleaks.toml`
and `.gitleaksignore` get extra scrutiny in review: on a pull request, the
workflow, the ignore files and the Betterleaks configuration come from the
pull request's own branch, and Betterleaks loads `betterleaks.toml` and
`.gitleaksignore` from the scanned repository by default.

## Rules worth knowing

These are summarized from [CLAUDE.md](CLAUDE.md), which is in French and has
the full list:

- Ansible never configures the inside of Incus, and `forge` never touches the
  host OS.
- No personal value (name, login, path, UID, identity, host, address) in code,
  tests or docs.
- Bash scripts use strict mode (`set -e`) and quote every variable.
- Every new nftables or Incus ACL rule has a comment justifying it, and
  nothing flushes the whole nftables ruleset.

## Agents

Claude Code sessions in this repository follow `CLAUDE.md`, and the hook in
`.claude/settings.json` applies to them.

An agent can also develop agent-forge on its own AWS VM, as a contributor: see
[docs/contributor-model.md](docs/contributor-model.md).

Its pull requests come from a bot's fork, through a relay that holds the bot's
credentials. A pull request that changes the files below changes that
boundary once merged and deployed, so they get extra scrutiny in review:
`cli/lib/relay/`, `cli/forge-relay*`, `ansible/roles/forge_relay/`,
`ansible/relay.yml`, `container/pre-bash.sh`, `CLAUDE.md` and
`.github/workflows/`. In the repository's settings, Actions, General, set
"Require approval for all outside collaborators", so that every workflow run
of such a pull request waits for the maintainer.

## License

By contributing, you agree that your contribution is licensed under the
repository's license, AGPL-3.0-only (see [LICENSE](LICENSE)).
