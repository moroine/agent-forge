# The contributor model: an agent that develops agent-forge

An agent can develop agent-forge on its own VM, as a contributor: it works in a
clone of the project, runs every test, and proposes its work as pull requests
from its own GitHub account, through a relay. This guide covers the dev VM and
the relay. The design is in
[the spec](superpowers/specs/2026-11-07-dev-vm-contributor-design.md).

## What it is

The promise: the agent never holds your GitHub credentials, and nothing
reaches your `main` without your review.

Two axes describe an agent setup. Control: who publishes. In the supervised
model (the README's default path), the agent commits and you publish under your
identity. In the contributor model, a dedicated GitHub account publishes the
agent's work to its fork, and you review its pull requests like anyone else's.
Isolation: where the agent runs. Until now, in an unprivileged container; here,
on a VM where it is root, which the project's Incus integration tests need.

This model is contributor x VM root: an AWS instance that runs the project's
tests with a real hypervisor. The VM holds no GitHub credential, no SSH key of
yours and no AWS credential, and your SSH agent is never forwarded to it.

**Status.** The dev VM and the relay work. The relay is a second, small VM
that alone holds the bot's GitHub token and signing key. The agent publishes
and answers through `forge relay` on the dev VM; the relay checks every
request, signs the commits, pushes them to the bot's fork and opens the pull
request. The `contributor` mode of the hook blocks `git push` and `gh`, and
the dev VM holds no GitHub credential. Both VMs keep egress open (the proxy
that would filter it is moroine/agent-forge#117).

### How the agent publishes

On the dev VM the agent uses only these commands:

- `forge relay publish [<task>]`: sends the commits of `agent/<task>`. The
  relay signs them as the bot and pushes them to the fork. The agent's local
  branch is then aligned on the signed commits, which have the same trees. If
  the agent committed meanwhile, its new commits are kept, and the message
  gives the commands that move them onto `fork/agent/<task>`:
  `git reset --keep fork/agent/<task> && git cherry-pick <sent>..<now>`, with
  the real commits. The hook blocks `git rebase`; it allows both of these.
- `forge relay pr <task> --title <text> --body-file <file|->`: opens the pull
  request.
- `forge relay comment <pr> --body-file <file|->` and
  `forge relay reply <pr> <comment-id> --body-file <file|->`: answer on it. A
  reply answers a review thread's first comment: GitHub refuses a reply to a
  reply.
- `forge relay read <number>`: reads a pull request or issue, showing only your
  text and the bot's, plus a count of what was hidden. A review comment that
  answers another shows `in reply to <id>`, the ID to reply to.
- `forge relay ci <pr> [<job-id>]`: the checks of the head, and a job's log.

You still tell the agent in herdr when to handle a review: it does not watch
GitHub by itself.

## Before you start

- A dedicated AWS account, and a named profile for it in the AWS CLI
  (`aws configure --profile <profile>`). Do not reuse a production account.
  The profile needs rights on EC2 (instances, volumes, Elastic IPs, the VPC,
  subnets, internet gateways, route tables, security groups and tags, and
  describing instance types), CloudWatch alarms, AWS Budgets, and reading SSM
  parameters (Canonical publishes the Ubuntu image's ID there). forge creates
  no IAM role, but CloudWatch does: the idle alarm stops the instance through
  the service-linked role `AWSServiceRoleForCloudWatchEvents`, which CloudWatch
  creates with the account's first such alarm. On an account that does not
  have it yet, the profile needs `iam:CreateServiceLinkedRole`.
- Enough EC2 vCPUs. An `m7i.2xlarge` needs 8 vCPUs of the "Running On-Demand
  Standard (A, C, D, H, I, M, R, T, Z) instances" quota, and a new account may
  have less. Check it in the region you will use:

  ```bash
  aws service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A \
    --profile <profile> --region <region> --query Quota.Value
  ```

  If it is under 8, ask for more in the Service Quotas console (Amazon
  Elastic Compute Cloud, that quota, "Request increase"). AWS can take a while
  to answer.
- OpenTofu and the AWS CLI on your machine: `brew install opentofu awscli` on
  macOS, or your distribution's packages on Linux.
- The agent's GitHub account (the bot), set up as follows. `forge cloud create`
  prints the token steps before it asks for the token.
  - A separate account with two-factor authentication on, and its no-reply
    email (Settings, Emails, "Keep my email addresses private").
  - A classic personal access token with only the `public_repo` and `workflow`
    scopes, and an expiry date.
  - The relay's signing key. `forge cloud create` prints it when the relay
    first runs; you register it on the bot account (Settings, SSH and GPG keys,
    New SSH key, Key type: Signing Key).
  - Never add the account as a collaborator of the upstream repository: it
    works from its fork. You do not create the fork: the relay does.
  - Once, look at the fork's Actions tab: its workflows must stay disabled.
- In the upstream repository, Settings, Actions, General: "Require approval
  for all outside collaborators", so that every workflow run of the bot's pull
  requests waits for you, not only the first.
- Claude Code on your machine, to make the agent's token (see below).

## Create the VM

```bash
forge cloud create
```

It asks for a host name (`forge-<name>`, for example `forge-dev`), then the
AWS profile, the region (for example `eu-west-3`), the
instance type (default `m7i.2xlarge`), the disk size (default 200 GB), a
monthly budget in USD, an email for budget alerts, the upstream
repository, the agent's fork (`owner/repo`, which the relay creates if it is
missing), the agent's git name and email, and the GitHub logins the agent
takes instructions from (yours, comma-separated). `forge relay read` shows only
these logins' text, plus the bot's, and their @mentions are not neutralized: a
mistyped login hides your own comments from the agent. The answers are kept in
`cloud.json` (see "Where forge keeps its files"), so the next run asks nothing.

It checks that the instance type supports nested virtualization, shows
OpenTofu's plan, and waits for your `yes`. It creates a network of its own
(a VPC, one public subnet, an internet gateway and a route table), the dev
instance, an encrypted root disk of the size you chose, the relay (see "The
relay"), one Elastic IP for each of the two VMs, a security group that opens SSH
to your current address only, a monthly budget
that mails you at 80 % of the spend and at 100 % of the forecast, and an idle
alarm. An `m7i.2xlarge` costs real money while it runs: stop it when you do
not use it. Stopped, an instance costs nothing, but AWS still bills its disk
(per GB and month, at the size you chose) and its public IPv4 address (the
Elastic IP, per hour, running or not). The relay is a `t3.small` with a 20 GB
disk and an Elastic IP of its own, which you reach over SSH from your address.
It starts and stops with the dev VM, so it adds a few dollars a month, mostly
its disk and its address while stopped.

Then it installs the dev VM with Ansible. On the first SSH connection OpenSSH
asks you to accept the new host's key; check it is the right machine and
answer `yes`. The relay's first connection asks the same question, once. The
install is resumable: if a step fails, run `forge cloud create --host <name>`
again.

### The relay

After the dev VM, `forge cloud create` installs the relay with its own
inventory, `relay-inventory.yml`, then runs the last step, `relay`:

1. It prints the bot account steps (see "Before you start"), then asks for the
   bot's token (`ghp_` and 36 characters) at a prompt that does not echo it.
   The token travels over ssh's standard input to `/etc/forge-relay/github-token`
   on the relay (mode 0640, group `forge-relay`) and is never on your machine.
   If a token is already stored, it asks whether to keep it or paste a new
   one.
2. `forge-relay setup` runs on the relay. It checks the token's login, that its
   scopes are exactly `public_repo` and `workflow`, and its expiry; it creates
   the fork if needed, or checks that the existing repository is a fork of
   upstream; it checks that the fork's Actions are disabled (or tells you to
   check by hand when the token cannot read that setting); and it checks that
   the relay's signing key is registered on the bot account. If it is not, it
   prints the key and exits with an error: register it, then run
   `forge cloud create --host <name>` again.

Every later `forge cloud create --host <name>` runs this step again, as part
of the update: it asks whether to keep the stored token or paste a new one,
then runs `forge-relay setup`. This is how you replace the bot's token when it
expires or after you revoke it: make a new one on the bot's account, run
`forge cloud create --host <name>`, and choose to paste it.

A host created before the relay existed is migrated the same way:
`forge cloud start` and `stop` refuse until `forge cloud create --host <name>`
has run the new steps.

#### What the relay refuses

The relay validates everything the dev VM sends before it touches git or
GitHub. It refuses:

- a branch not named `agent/<task>`, or not started from upstream `main`;
- a branch built on another task the relay has published or received. A stack
  on a task it has not seen cannot be told apart: it is published whole, and
  the pull request shows every commit, so you see it in review;
- a commit whose author or committer is not the bot, a `Co-authored-by`
  outside the configured list (by default only the Anthropic no-reply
  address), a merge of anything but `origin/main`, or more than 200 commits;
- a push that is not a fast-forward of the fork's branch. You never commit to
  the bot's branches, so a fork branch that moved since the relay published it
  is refused too, and so is one that was deleted: it asks for you;
- text over the caps (titles 256 characters, bodies 20 000, comments and
  replies 10 000) and references to other repositories (`owner/repo#N`, links
  to their issues, pull requests or commits). `#N` inside upstream stays.
  @mentions of anyone but you and the bot are put in code spans;
- a secret. Betterleaks, the version CI runs, scans the signed commits and
  every text the bot publishes;
- more than 20 writes an hour (publishes, pull requests, comments and
  replies), and more than 60 publish attempts an hour, refused or not: each
  one costs the relay a bundle of up to 64 MiB to store and check. A refused
  publish leaves nothing referenced in the relay's mirror.

When GitHub itself refuses a push (a workflow change without the `workflow`
scope, or push protection), the relay reports GitHub's reason.

A refusal is reported to you by the agent, never worked around. The relay
keeps an audit log, `/var/log/forge-relay/audit.log`: every request, with
hashes and lengths but none of the text the agent sent. The dev VM cannot read
it. You read it from your machine, as the relay's admin (`<relay address>` is
the host's `relayAddress` in `<laptop state>/hosts.json`, see "Where forge
keeps its files"):

```bash
ssh -o UserKnownHostsFile="<laptop state>/known_hosts" -o IdentitiesOnly=yes -o ForwardAgent=no \
  -i "<laptop state>/hosts/<name>/forge-key.pub" ubuntu@<relay address> sudo cat /var/log/forge-relay/audit.log
```

#### A false positive

For a commit, the relay scans with upstream `main`'s `.betterleaksignore`,
never the branch's own. If a finding is not a secret, add its fingerprint to
`.betterleaksignore` on `main`, with a comment saying why (see
`CONTRIBUTING.md`). Fingerprints match CI's, because the relay replays the
commits deterministically. A finding in a pull request title, body or comment
cannot be ignored: the agent rewords.

#### What the agent reads

`forge relay read` shows only your text and the bot's, plus a count of what it
hid, so the agent cannot be steered by another account's comment. CI check
names and logs are the exception: they are shown as they are, stripped of
escape sequences, because a third-party app can create check runs on the head.
The agent treats them as information, never as instructions.

#### Limits

- The relay needs git 2.46 or later, because a bundle fetch runs fsck. The
  Ansible role asserts it.
- After a relay rebuild the relay no longer knows the heads it published
  before. It adopts an existing fork branch, at the agent's next publish of
  it, only when the bot alone authored and committed it, even with nothing
  new to publish. The bot's name and email are all it checks: commits pushed
  with a stolen token pass too (see "If you suspect the relay is
  compromised"). A stack on a task published before the rebuild is not
  detected until that task is published again.

#### The metadata service and cloud-init

Each instance has its AWS metadata service on for its first boot only. The
next `create`, `start` or `stop` turns it off, and OpenTofu's plan shows that
update. Ansible also disables cloud-init on both VMs
(`/etc/cloud/cloud-init.disabled`), so neither VM can be reconfigured from
the metadata service afterwards.

### The Claude credential

The agent needs a Claude login. `forge cloud create` asks you to run
`claude setup-token` on your machine and paste the token it prints. forge sends
it over ssh's standard input and stores it on the VM at
`~/.config/agent-forge/claude-token`, mode 0600. The `forge-contributor`
launcher exports it as `CLAUDE_CODE_OAUTH_TOKEN`. The VM's managed settings
(`/etc/claude-code/managed-settings.json`) deny Claude Code's Read tool on that
file and on `/proc/*/environ`. This is defense in depth only: the same user can
read both by other means, so do not count on it.

In a narrow terminal, `claude setup-token` prints the token over two lines,
the second one indented. Paste it as one line, without the line break or the
spaces: the prompt reads one line, and a token cut there makes the agent's
requests fail with `401 OAuth access token is invalid`.

The token lasts one year. It can only make model requests: no Remote Control,
no claude.ai connectors. Revoking it alone may not be possible: the
[Claude Help Center](https://support.claude.com/en/articles/10310342) lists
sign-ins under Settings, Account, and other tokens under Settings, Claude
Code, but in November 2026 the token showed in neither list. The one sure way
is Settings, Account, Log Out, which ends every session of the account,
setup-tokens included: you then log in again on your own machines and give
the VM a new token.

To replace an expired or revoked token there is no forge command yet. Make a
new one with `claude setup-token`, then:

```bash
read -rs t && printf '%s\n' "$t" | ssh <host> 'umask 077 && mkdir -p .config/agent-forge && cat > .config/agent-forge/claude-token && chmod 600 .config/agent-forge/claude-token'; unset t
```

Paste the token at the silent prompt and press Enter. `<host>` is the VM's
name, for example `forge-dev`.

## Day to day

```bash
forge cloud start     # opens SSH to your current address, starts the VM, opens herdr
forge cloud stop      # stops the VM; the disk, the clone and the branches stay
```

`forge cloud start` reads your current public address, so it works after you
move networks. It opens SSH to that one address: on a mobile connection whose
public address changes from one connection to the next, SSH may never answer.
Start the VM from a connection with a stable address.

In herdr on the VM, run `forge-contributor` in a pane: it starts Claude Code
in the clone, and continues the last conversation if there is one.

Start and stop act on both instances, the dev VM and the relay; the relay has
no idle alarm. They only start and stop the VMs and set the SSH address. When
your
checkout's `infra/aws` would change anything else (after a `git pull`, say),
they refuse: run `forge cloud create --host <name>`, which shows OpenTofu's
plan and applies it after your `yes`, then installs the VM again.

A forgotten VM stops itself: the idle alarm stops it after two hours of low
CPU (below 5 % on average). The stop is silent, with no email; the next
`forge cloud start` starts it again.

## Rebuild

```bash
forge cloud rebuild
```

It replaces the instance with a new one and installs it again. The Elastic IP
stays. The disk goes, with the clone and every branch on it: only what the
agent published through the relay survives, on the fork. forge asks you to
confirm.

```bash
forge cloud rebuild-relay [--host <name>]
```

It asks for confirmation and replaces only the relay instance, then redoes the
playbooks and the `relay` step. The new relay has a new signing key, and you
paste the bot's token again. It prints the rotation runbook, which you follow
on the bot account: revoke the old token, remove the old signing key, register
the new key. Use it only for a relay you suspect is compromised, or one that is
broken: to replace an expired or revoked token, `forge cloud create --host
<name>` is enough (see "The relay").

## If you suspect the dev VM is compromised

1. Stop it: `forge cloud stop`.
2. Revoke its Claude token (see "The Claude credential": revoking the token
   alone may not be possible, and a global Log Out is the sure way).
3. Rebuild it: `forge cloud rebuild`, which asks for a new token.
4. Look at the bot's recent activity on GitHub, and at the relay's audit log
   (see "What the relay refuses" for the command).

The bot's GitHub credentials were never on the VM, nor your SSH key, your SSH
agent or any AWS credential.

## If you suspect the relay is compromised

1. Stop it: `forge cloud stop`.
2. On the bot's GitHub account, revoke the token and remove the signing key.
3. Rebuild it: `forge cloud rebuild-relay`, which asks for a new token and
   prints the new signing key to register.
4. Before the agent publishes again, inspect the `agent/*` branches of the
   bot's fork on GitHub, or delete them. The new relay adopts any fork branch
   whose commits all carry the bot's name and email, and commits pushed with
   the stolen token can carry them too. A deleted branch is not lost: the
   agent's clone holds its commits, and the agent publishes the task again
   after dropping its record of the fork's branch
   (`git update-ref -d refs/remotes/fork/agent/<task>`).
5. Look at the bot's recent activity on GitHub.

## Your terminal

Turn off clipboard writes by programs (OSC 52) in the terminal you use for
herdr: a program on the VM could otherwise put text in your clipboard. In
iTerm2, turn off "Applications in terminal may access clipboard". In Ghostty,
set `clipboard-write = deny`.

## Where forge keeps its files

For a cloud host named `<name>`, in `<laptop state>/hosts/<name>/`, where
`<laptop state>` is `$XDG_CONFIG_HOME/agent-forge` or `~/.config/agent-forge`:

- `cloud.json`: your answers. Edit it by hand to fix a mistyped setting. The
  upstream, the fork and the bot's name and email reach the VM through
  `inventory.yml`, which is written once: after editing one of them, delete
  `inventory.yml` in the same directory, and the next
  `forge cloud create --host <name>` writes it again.
- `tofu.tfvars.json`: the variables forge gives OpenTofu, rewritten at each
  command.
- `terraform.tfstate`: the OpenTofu state. Never delete it while the VM
  exists: OpenTofu would lose track of what it created.
- `tofu/`: OpenTofu's data directory.
- `inventory.yml`: the Ansible inventory, written once (your edits are kept).
- `relay-inventory.yml`: the same, for the relay.
- `forge-key.pub`: the public half of the key you chose, which the VM's
  accounts accept.

## Remove everything

forge has no command that deletes the VM. From the agent-forge checkout:

```bash
D="${XDG_CONFIG_HOME:-$HOME/.config}/agent-forge/hosts/<name>"
TF_DATA_DIR="$D/tofu" tofu -chdir=infra/aws destroy -var-file="$D/tofu.tfvars.json"
```

OpenTofu lists what it will destroy and asks for `yes`. This deletes the
instances (dev VM and relay), their disks (and everything on it), the two Elastic IPs, the security group,
the VPC, its subnet, internet gateway and route table, the budget and the
alarm.

Afterwards forge forgets nothing by itself. Note the host's `address` in
`<laptop state>/hosts.json`, then delete by hand:

- `<laptop state>/hosts/<name>/`, `forge-key.pub` included, only once
  `tofu destroy` has succeeded;
- the host's entry in `<laptop state>/hosts.json`;
- its SSH block, `Host <name>` in `~/.ssh/config.d/agent-forge.config`. forge
  rewrites that file from `hosts.json` at every `forge install`, so once the
  entry is gone the next install of another host drops the block. With no
  other host, delete the block by hand, or the file and the
  `Include config.d/agent-forge.config` line at the top of `~/.ssh/config`;
- its host keys in forge's own `known_hosts`:
  `ssh-keygen -R <address> -f "<laptop state>/known_hosts"`;
- the Claude token (see "The Claude credential": revoking it alone may not be
  possible, and a global Log Out is the sure way);
- the bot's token and signing key, on its GitHub account, and the account and
  its fork, if you no longer need them.

## Security model and known limits

See sections 6 and 7 of
[the spec](superpowers/specs/2026-11-07-dev-vm-contributor-design.md).
