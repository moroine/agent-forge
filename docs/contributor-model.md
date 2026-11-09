# The contributor model: an agent that develops agent-forge

An agent can develop agent-forge on its own VM, as a contributor: it works in a
clone of the project, runs every test, and (once the relay exists) proposes its
work as pull requests from its own GitHub account. This guide covers the dev
VM. The design is in
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

**Status.** The dev VM works. Publishing does not yet: the relay that pushes
the agent's branches to its fork and opens pull requests comes next. Until
then the agent cannot publish. The `contributor` mode of the hook blocks
`git push` and `gh`, and the VM holds no GitHub credential. The agent's work
stays on the VM, where you read it: in herdr, or over `ssh <host>`.

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
- The agent's GitHub account: a separate account, a fork of the repository
  under it, and its no-reply email (Settings, Emails, "Keep my email addresses
  private"). Never add the account as a collaborator of the upstream
  repository: it works from its fork.
- Claude Code on your machine, to make the agent's token (see below).

## Create the VM

```bash
forge cloud create
```

It asks for a host name (`forge-<name>`, for example `forge-dev`), then the
AWS profile, the region (for example `eu-west-3`), the
instance type (default `m7i.2xlarge`), the disk size (default 200 GB), a
monthly budget in USD, an email for budget alerts, the upstream
repository, the agent's fork (`owner/repo`), and the agent's git name and
email. The answers are kept in `cloud.json` (see "Where forge keeps its
files"), so the next run asks nothing.

It checks that the instance type supports nested virtualization, shows
OpenTofu's plan, and waits for your `yes`. It creates a network of its own
(a VPC, one public subnet, an internet gateway and a route table), one
instance, one Elastic IP, an encrypted root disk of the size you chose, a
security group that opens SSH to your current address only, a monthly budget
that mails you at 80 % of the spend and at 100 % of the forecast, and an idle
alarm. An `m7i.2xlarge` costs real money while it runs: stop it when you do
not use it. Stopped, the instance costs nothing, but AWS still bills its disk
(per GB and month, at the size you chose) and its public IPv4 address (the
Elastic IP, per hour, running or not).

Then it installs the VM with Ansible. On the first SSH connection OpenSSH asks
you to accept the new host's key; check it is the right machine and answer
`yes`. The install is resumable: if a step fails, run
`forge cloud create --host <name>` again.

### The Claude credential

The agent needs a Claude login. `forge cloud create` asks you to run
`claude setup-token` on your machine and paste the token it prints. forge sends
it over ssh's standard input and stores it on the VM at
`~/.config/agent-forge/claude-token`, mode 0600. The `forge-contributor`
launcher exports it as `CLAUDE_CODE_OAUTH_TOKEN`.

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
Start the VM from a connection with a stable address. In herdr on the VM, run `forge-contributor` in a pane: it
starts Claude Code in the clone, and continues the last conversation if there
is one.

Start and stop only start and stop the VM and set the SSH address. When your
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
stays. The disk goes, with the clone and every branch on it: until the relay
exists, none of the agent's work is published anywhere else. forge asks you to
confirm.

## If you suspect the dev VM is compromised

1. Stop it: `forge cloud stop`.
2. Revoke its Claude token in claude.ai (see "The Claude credential").
3. Rebuild it: `forge cloud rebuild`, which asks for a new token.

The bot's GitHub credentials were never on the VM, nor your SSH key, your SSH
agent or any AWS credential. Once the relay exists, also look at the bot's
recent activity on GitHub and at the relay's audit log.

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
- `forge-key.pub`: the public half of the key you chose, which the VM's
  accounts accept.

## Remove everything

forge has no command that deletes the VM. From the agent-forge checkout:

```bash
D="${XDG_CONFIG_HOME:-$HOME/.config}/agent-forge/hosts/<name>"
TF_DATA_DIR="$D/tofu" tofu -chdir=infra/aws destroy -var-file="$D/tofu.tfvars.json"
```

OpenTofu lists what it will destroy and asks for `yes`. This deletes the
instance, its disk (and everything on it), the Elastic IP, the security group,
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
- the Claude token, in claude.ai (see above);
- the agent's fork and GitHub account, if you no longer need them.

## Security model and known limits

See sections 6 and 7 of
[the spec](superpowers/specs/2026-11-07-dev-vm-contributor-design.md).
