import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, statSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  addInclude, forgeSshConfigDefines, hostDefinedElsewhere, includeState, overriddenSettings,
  removeOldForgeSshConfig, renderForgeSshConfig, sshOption, writeForgeSshConfig,
} from "../cli/lib/laptop/ssh-config.ts";
import { ForgeError } from "../cli/lib/context.ts";
import type { LaptopHost } from "../cli/lib/laptop/state.ts";
import { fakeContext } from "./lib/fake-context.ts";

const lima: LaptopHost = {
  name: "forge-local", kind: "lima", address: "127.0.0.1", port: 60022, user: "forge",
  admin: "alice", adminKey: "/lima/_config/user", exposure: "local", done: [],
};
const remote: LaptopHost = {
  name: "forge-acme", kind: "remote", address: "203.0.113.10", port: 22, user: "forge",
  admin: "ubuntu", adminKey: "/keys/admin", exposure: "public",
  identityAgent: "/run/agent.sock", done: [],
};
const o = { knownHosts: "/state/known_hosts", keyPath: (n: string) => `/state/${n}/forge-key.pub` };

function withSshDir<T>(fn: (dir: string) => T): T {
  const dir = join(mkdtempSync(join(tmpdir(), "forge-ssh-")), ".ssh");
  const old = process.env.FORGE_SSH_DIR;
  process.env.FORGE_SSH_DIR = dir;
  try { return fn(dir); } finally {
    if (old === undefined) delete process.env.FORGE_SSH_DIR; else process.env.FORGE_SSH_DIR = old;
  }
}

test("renders a lima and a remote host", () => {
  assert.equal(renderForgeSshConfig([lima, remote], o), `# Managed by forge install: edits are overwritten.

Host forge-local
  HostName 127.0.0.1
  Port 60022
  User forge
  HostKeyAlias forge-local
  StrictHostKeyChecking accept-new
  UserKnownHostsFile /state/known_hosts
  IdentityFile /state/forge-local/forge-key.pub
  IdentitiesOnly yes
  ForwardAgent yes

Host forge-acme
  HostName 203.0.113.10
  Port 22
  User forge
  UserKnownHostsFile /state/known_hosts
  IdentityFile /state/forge-acme/forge-key.pub
  IdentitiesOnly yes
  IdentityAgent /run/agent.sock
  ForwardAgent yes
`);
});

test("a path with spaces is double-quoted", () => {
  const text = renderForgeSshConfig(
    [{ ...remote, identityAgent: "/Users/a b/agent.sock" }],
    { knownHosts: "/my state/known_hosts", keyPath: () => "/my state/key.pub" },
  );
  assert.match(text, /^ {2}IdentityAgent "\/Users\/a b\/agent\.sock"$/m);
  assert.match(text, /^ {2}IdentityFile "\/my state\/key\.pub"$/m);
  assert.match(text, /^ {2}UserKnownHostsFile "\/my state\/known_hosts"$/m);
});

test("sshOption quotes a value the way ssh reads it", () => {
  assert.equal(sshOption("IdentityAgent", "/run/agent.sock"), "IdentityAgent=/run/agent.sock");
  assert.equal(sshOption("IdentityAgent", "/a b/s"), 'IdentityAgent="/a b/s"');
  assert.equal(sshOption("IdentityAgent", "/o'b/s"), `IdentityAgent="/o'b/s"`);
  assert.equal(sshOption("IdentityAgent", '/q"x\\y'), String.raw`IdentityAgent="/q\"x\\y"`);
});

// `-G` only parses the options, it never connects.
test("ssh itself reads an sshOption value back whole", { skip: spawnSync("ssh", ["-V"]).status !== 0 }, () => {
  for (const path of ["/run/agent.sock", "/Users/a  b/Group Containers/agent.sock", "/o'b/s", '/q"x\\y  z']) {
    const r = spawnSync("ssh", ["-F", "/dev/null", "-G", "-o", sshOption("IdentityAgent", path), "example.invalid"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.split("\n").includes(`identityagent ${path}`), path);
  }
});

test("writes the file 0600 in 0700 directories, atomically", () => {
  withSshDir((dir) => {
    writeForgeSshConfig("one\n");
    writeForgeSshConfig("two\n");
    const file = join(dir, "config.d", "agent-forge.config");
    assert.equal(readFileSync(file, "utf8"), "two\n");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "config.d")).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(join(dir, "config.d")), ["agent-forge.config"]);
  });
});

// OpenSSH's `Include config.d/*` skips dotfiles: an interrupted write never
// leaves a temp file that ssh would read.
test("the temp file is a dotfile, outside the Include glob", () => {
  withSshDir((dir) => {
    // A directory in the way makes the rename fail and leaves the temp file.
    mkdirSync(join(dir, "config.d", "agent-forge.config", "x"), { recursive: true });
    assert.throws(() => writeForgeSshConfig("one\n"));
    assert.deepEqual(readdirSync(join(dir, "config.d")).sort(), [".agent-forge.forge-tmp", "agent-forge.config"]);
  });
});

// Earlier versions wrote config.d/agent-forge: it goes when forge wrote it
// (its header line), any other file of that name stays. Writing forge's file
// leaves it: install removes it once ssh is known to read the new one.
test("an old config.d/agent-forge written by forge is removed, any other one kept", () => {
  withSshDir((dir) => {
    const old = join(dir, "config.d", "agent-forge");
    mkdirSync(dirname(old), { recursive: true });
    writeFileSync(old, renderForgeSshConfig([lima], o));
    writeForgeSshConfig("new\n");
    assert.equal(existsSync(old), true);
    removeOldForgeSshConfig();
    assert.equal(existsSync(old), false);
    assert.equal(readFileSync(join(dir, "config.d", "agent-forge.config"), "utf8"), "new\n");

    writeFileSync(old, "Host mine\n  HostName 192.0.2.1\n");
    removeOldForgeSshConfig();
    assert.equal(readFileSync(old, "utf8"), "Host mine\n  HostName 192.0.2.1\n");
  });
  withSshDir((dir) => {
    mkdirSync(join(dir, "config.d", "agent-forge"), { recursive: true });
    removeOldForgeSshConfig();
    assert.ok(statSync(join(dir, "config.d", "agent-forge")).isDirectory());
  });
});

test("forgeSshConfigDefines counts an old config.d/agent-forge that forge wrote", () => {
  withSshDir((dir) => {
    const old = join(dir, "config.d", "agent-forge");
    mkdirSync(dirname(old), { recursive: true });
    writeFileSync(old, renderForgeSshConfig([lima], o));
    assert.equal(forgeSshConfigDefines("forge-local"), true);
    writeFileSync(old, "Host forge-local\n  HostName 192.0.2.1\n");
    assert.equal(forgeSshConfigDefines("forge-local"), false);
  });
});

test("forgeSshConfigDefines sees only a Host line of forge's own file", () => {
  withSshDir(() => {
    assert.equal(forgeSshConfigDefines("forge-acme"), false);
    writeForgeSshConfig(renderForgeSshConfig([remote], o));
    assert.equal(forgeSshConfigDefines("forge-acme"), true);
    assert.equal(forgeSshConfigDefines("forge-other"), false);
  });
});

// FORGE_HOME and FORGE_SSH_DIR in a temporary home: `~/` and `~/.ssh` agree.
function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "forge-home-"));
  const old = { home: process.env.FORGE_HOME, ssh: process.env.FORGE_SSH_DIR };
  process.env.FORGE_HOME = home;
  process.env.FORGE_SSH_DIR = join(home, ".ssh");
  try { return fn(home); } finally {
    if (old.home === undefined) delete process.env.FORGE_HOME; else process.env.FORGE_HOME = old.home;
    if (old.ssh === undefined) delete process.env.FORGE_SSH_DIR; else process.env.FORGE_SSH_DIR = old.ssh;
  }
}

// OpenSSH reads config.d/ only through an Include that applies to every host:
// at the top level, under `Match all`, or under `Host *`.
test("an Include that covers forge's file for every host is detected", () => {
  withHome(() => {
    // The maintainer's layout: `Match All` makes what follows global again.
    const layout = 'Host *\n  IdentityAgent "/run/user agent.sock"\n\nMatch All\nInclude ~/.ssh/config.d/*.config\n';
    assert.equal(includeState(layout), "covered");
    for (const text of [
      "Include config.d/*\n\nHost gh\n  User git\n",
      "# mine\n\nInclude ~/.ssh/config.d/*\nHost gh\n",
      "Include config.d/agent-forge.config\n",
      "include=config.d/*\n",
      "Include = config.d/*.config\n",
      "INCLUDE other.conf config.d/*\n",
      "Host *\n  Include config.d/*\n",
      "Host gh\n  User git\nMatch all\n  Include config.d/*.config\n",
      'Include "config.d/*.config"\n',
      "Include 'config.d/agent-forge.config'\n",
      'Include "my dir/*.conf" config.d/*\n',
      "Include config.d/agent-forge.confi?\n",
      "Include config.d/[a-c]gent-forge.config\n",
      "Include config.d/agent-forge.[!x]onfig\n",
      "Include config.d/[^a]gent-forge.config\n",
      "Include */agent-forge.config\n",
      "Include ~/.*/config.d/*\n",
    ]) assert.equal(includeState(text), "covered", text);
  });
});

test("an Include that misses forge's file, or applies to some hosts only, is not enough", () => {
  withHome(() => {
    for (const text of [
      "",
      "Include other.conf\n",
      "Include config.d/*.conf\n",
      "Include config.d/agent-forge\n",
      "Include config.d/*.conf # config.d/*\n",
      "Host github.com\n  Include config.d/*\n",
      "Host * !gh\n  Include config.d/*\n",
      "Match host gh\n  Include config.d/*\n",
      "Match all\nHost gh\n  Include config.d/*\n",
      "Include config.d/[!a]gent-forge.config\n",
      // macOS's glob reads `^` as a plain character, not a negation.
      "Include config.d/[^x]gent-forge.config\n",
      "Include config.d/agent-forge.conf[a-f]?\n",
      // A wildcard never matches a leading dot: not ~/.ssh.
      "Include ~/*/config.d/*\n",
      "Include ~/.ssh/*\n",
    ]) assert.equal(includeState(text), "missing", text);
  });
});

test("an absolute Include path is compared with forge's file", () => {
  withSshDir((dir) => {
    assert.equal(includeState(`Include ${join(dir, "config.d", "*")}\n`), "covered");
    assert.equal(includeState(`Include ${join(dir, "config.d", "agent-forge.config")}\n`), "covered");
    assert.equal(includeState(`Include ${join(dir, "config.d", "*.conf")}\n`), "missing");
  });
});

test("the Include goes above the first Host line", () => {
  const input = "# my config\nHost *\n  ServerAliveInterval 30\n\nHost gh\n  User git\n";
  assert.equal(addInclude(input), `Include config.d/agent-forge.config\n\n${input}`);
  assert.equal(addInclude(""), "Include config.d/agent-forge.config\n");
  assert.equal(includeState(addInclude(input)), "covered");
});

// What ssh resolves for the alias, against forge's block: a value read before
// forge's file wins (ssh keeps the first), and identity files are offered in
// the order read.
const KEY_PATH = "/state/forge-local/forge-key.pub";
const inEffect = [
  "user forge", "hostname 127.0.0.1", "port 60022", "identitiesonly yes", "stricthostkeychecking accept-new",
  "hostkeyalias forge-local", "identityagent /run/agent.sock", `identityfile ${KEY_PATH}`,
  "identityfile ~/.ssh/id_ed25519", "userknownhostsfile /state/known_hosts /home/a/.ssh/known_hosts2",
  "forwardagent yes",
].join("\n") + "\n";
const withAgent: LaptopHost = { ...lima, identityAgent: "/run/agent.sock" };

test("overriddenSettings is empty when forge's values are in effect", async () => {
  const ctx = fakeContext({ rules: [{ match: "ssh -G forge-local", stdout: inEffect }] });
  assert.deepEqual(await overriddenSettings(ctx, withAgent, o), []);
  // A host name compares without case.
  const upper = fakeContext({ rules: [{ match: "ssh -G forge-acme", stdout: "hostname host.example\nport 22\nuser forge\n" +
    "userknownhostsfile /state/known_hosts\nidentityfile /state/forge-acme/forge-key.pub\nidentitiesonly yes\nforwardagent yes\n" }] });
  assert.deepEqual(await overriddenSettings(upper, { ...remote, address: "Host.Example", identityAgent: undefined }, o), []);
});

test("overriddenSettings names each setting of the developer's that wins over forge's", async () => {
  // The review's probe: Host * with these values, then Match all and the Include.
  const probe = [
    "user me", "hostname 127.0.0.1", "port 60022", "identitiesonly yes", "stricthostkeychecking yes",
    "hostkeyalias forge-local", "identityagent /run/other.sock", "identityfile ~/.ssh/id1", "identityfile ~/.ssh/id2",
    `identityfile ${KEY_PATH}`, "userknownhostsfile /home/a/.ssh/other /state/known_hosts", "forwardagent no",
  ].join("\n") + "\n";
  const ctx = fakeContext({ rules: [{ match: "ssh -G forge-local", stdout: probe }] });
  assert.deepEqual(await overriddenSettings(ctx, withAgent, o), [
    "`User me` from your ~/.ssh/config wins over forge's `User forge`",
    "`StrictHostKeyChecking yes` from your ~/.ssh/config wins over forge's `StrictHostKeyChecking accept-new`",
    "`UserKnownHostsFile /home/a/.ssh/other /state/known_hosts` from your ~/.ssh/config wins over forge's `UserKnownHostsFile /state/known_hosts`",
    `\`IdentityFile ~/.ssh/id1\` from your ~/.ssh/config is offered before forge's \`IdentityFile ${KEY_PATH}\``,
    "`IdentityAgent /run/other.sock` from your ~/.ssh/config wins over forge's `IdentityAgent /run/agent.sock`",
    "`ForwardAgent no` from your ~/.ssh/config wins over forge's `ForwardAgent yes`",
  ]);
});

test("overriddenSettings: forge's file not read at all, or ssh -G failing", async () => {
  const unread = fakeContext({ rules: [{ match: "ssh -G forge-local", stdout: "hostname forge-local\nport 22\nuser alice\n" }] });
  const lines = await overriddenSettings(unread, lima, o);
  assert.ok(lines.includes("`HostName forge-local` from your ~/.ssh/config wins over forge's `HostName 127.0.0.1`"), lines.join("\n"));
  assert.ok(lines.includes("forge's `HostKeyAlias forge-local` is not in effect"), lines.join("\n"));
  const failing = fakeContext({ rules: [{ match: "ssh -G forge-local", code: 255, stderr: "line 3: Bad configuration option" }] });
  await assert.rejects(overriddenSettings(failing, lima, o), (e: Error) =>
    e instanceof ForgeError && /ssh -G forge-local/.test(e.message) && /Bad configuration option/.test(e.message));
});

test("hostDefinedElsewhere compares the resolved hostname", async () => {
  const other = fakeContext({ rules: [{ match: "ssh -G forge-acme", stdout: "user x\nhostname 203.0.113.10\nport 22\n" }] });
  assert.equal(await hostDefinedElsewhere(other, "forge-acme"), true);
  const unset = fakeContext({ rules: [{ match: "ssh -G forge-acme", stdout: "hostname Forge-Acme\n" }] });
  assert.equal(await hostDefinedElsewhere(unset, "forge-acme"), false);
  const failing = fakeContext({ rules: [{ match: "ssh -G", code: 255 }] });
  assert.equal(await hostDefinedElsewhere(failing, "forge-acme"), false);
});

test("a cloud host never gets the agent and has no HostKeyAlias; a remote host does", () => {
  const cloud: LaptopHost = { ...remote, name: "forge-dev", kind: "cloud" };
  const text = renderForgeSshConfig([cloud, remote], o);
  const [c, r] = text.split("Host ").slice(1);
  assert.match(c, /ForwardAgent no/);
  assert.doesNotMatch(c, /ForwardAgent yes|HostKeyAlias/);
  assert.match(r, /ForwardAgent yes/);
});
