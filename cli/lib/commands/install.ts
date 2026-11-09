// forge install (spec "Sub-project 3: guided install"): installs or updates a
// forge host from the laptop, the Lima VM forge-local, a remote VM
// forge-<name>, or a cloud host forge-<name> (the contributor's dev VM and its
// relay, which OpenTofu creates: `forge cloud create`). Each step is recorded
// in hosts.json when it succeeds and skipped on a re-run, so that a re-run
// picks up after a failure; a re-run of a finished host is an update
// (playbook, setup and image again; a cloud host's are OpenTofu, the
// playbooks and the relay's setup).
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ForgeError, type Context } from "../context.ts";
import { addLaptopBlock, laptopToasts, readConfig } from "../herdr-config.ts";
import { forgeHome, herdrConfigPath, laptopDataDir, limaHome, repoRoot, sshDir } from "../paths.ts";
import {
  applyInteractive, askCloudSettings, askRelaySettings, checkNestedVirt, currentPublicIp, infraFor, infraOutputs,
  loadCloudSettings, saveCloudSettings,
} from "../laptop/cloud.ts";
import {
  ensureClaudeLogin, ensureClaudeToken, ensureGitIdentity, ensureImage, ensureRelayCredentials, runSetup,
} from "../laptop/host-steps.ts";
import { renderInventory, renderRelayInventory, writeInventoryOnce } from "../laptop/inventory.ts";
import { chooseKey, githubAgent, keyLabel, listAgentKeys } from "../laptop/keys.ts";
import {
  ensureLimaVm, forgetHostKeys, HOST_KEY_ALIAS, LIMA_DEFAULT_PORT, LIMA_NAME, limaInstance, type LimaInstance,
  type LimaOptions,
} from "../laptop/lima.ts";
import { checkPrerequisites } from "../laptop/prereqs.ts";
import { adminSsh } from "../laptop/remote.ts";
import {
  addInclude, forgeSshConfigDefines, forgeSshConfigPath, hostDefinedElsewhere, INCLUDE_LINE, includeState,
  overriddenSettings, removeOldForgeSshConfig, renderForgeSshConfig, writeForgeSshConfig,
} from "../laptop/ssh-config.ts";
import {
  forgeKeyPath, forgetHost, hostDir, inventoryPath, knownHostsPath, loadHosts, relayClientKeyPath, relayInventoryPath,
  relayLinkPath, saveHost, selectHost, validHostName, type InstallStep, type LaptopHost,
} from "../laptop/state.ts";
import { cmdOpen } from "./open.ts";

// `lima` lets the tests skip ensureLimaVm's waits, `sleep` the wait for a
// cloud VM's sshd. `cloud` installs a new cloud host (forge cloud create).
export type InstallOptions = {
  remote?: string; host?: string; cloud?: boolean; checkout?: string; lima?: LimaOptions;
  sleep?: (ms: number) => Promise<void>;
};

type Outcome = "done" | "already there";
type Target = { kind: LaptopHost["kind"]; listed?: LaptopHost; address: string };

const STEPS: InstallStep[] = ["vm", "inventory", "playbook", "ssh", "identity", "claude", "setup", "image"];
// A cloud host gets neither this machine's git identity (the agent commits as
// the bot, which the playbook sets) nor forge setup and the image: the
// agent's tests run them on the VM (spec §5.3). Its last step is the relay's
// credentials: a host installed before the relay existed lacks it, so start
// and stop send it back to forge cloud create --host, which adds the relay.
export const CLOUD_STEPS: InstallStep[] = ["vm", "inventory", "playbook", "ssh", "claude", "relay"];
const stepsFor = (kind: LaptopHost["kind"]): InstallStep[] => (kind === "cloud" ? CLOUD_STEPS : STEPS);
// What a re-run of a finished host runs again: re-running is updating. Only
// a cloud host has the relay step: the bot's token has no expiry, but a
// revoked one is replaced here, so its update asks to keep the stored token
// or paste a new one, and runs the relay's setup again, which checks the
// token, the fork, Actions and the two keys.
const UPDATE: InstallStep[] = ["playbook", "setup", "image", "relay"];
const LABELS: Record<InstallStep, string> = {
  vm: "VM", inventory: "inventory", playbook: "playbook", ssh: "SSH configuration", identity: "git identity",
  claude: "Claude login", setup: "forge setup", image: "agent-base image", relay: "relay setup",
};
const USER_NAME = /^[a-z_][a-z0-9_-]*$/;
// A host name or an IP address: never an ssh option, never user@host.
const ADDRESS = /^[A-Za-z0-9][A-Za-z0-9.:-]*$/;
// The cloud VM's account, which OpenTofu gives the chosen key (Ubuntu's AMI).
const CLOUD_ADMIN = "ubuntu";
// A new cloud VM's sshd: probed every 5 s, for 3 minutes at most.
const SSH_WAIT_MS = 5000;
const SSH_TRIES = 36;

// A remote's VM step is its first connection (it has no VM to create); a cloud
// host's Claude step stores a token, not a login.
const label = (step: InstallStep, kind: LaptopHost["kind"]): string =>
  step === "vm" && kind === "remote" ? "first SSH connection"
    : step === "claude" && kind === "cloud" ? "Claude token"
    : LABELS[step];

// The command that resumes a host's install.
const resumeCommand = (host: LaptopHost): string =>
  host.kind === "remote" ? `forge install --host ${host.name}`
    : host.kind === "cloud" ? `forge cloud create --host ${host.name}`
    : "forge install";

export async function cmdInstall(ctx: Context, opts: InstallOptions = {}): Promise<number> {
  const checkout = opts.checkout ?? repoRoot();
  // 1-3. Which host, the laptop's tools, the key GitHub accepts.
  const target = await whichHost(ctx, opts);
  await checkPrerequisites(ctx, target.kind);
  // A remote only. A cloud host is never forgotten (its directory holds the
  // OpenTofu state): its VM step simply runs again.
  if (target.kind === "remote" && target.listed && !target.listed.done.includes("vm")) {
    await retryOrForget(ctx, target.listed);
  }
  const { key, agent } = await forgeKey(ctx, target.listed);
  // 4-5. A new host is saved, with its key, before anything is created.
  let host: LaptopHost;
  let vm: LimaInstance | null = null;
  if (target.kind === "lima") ({ host, vm } = await limaHost(ctx, target.listed, key, agent));
  else if (target.kind === "cloud") host = target.listed ?? (await newCloudHost(ctx, key, agent));
  else host = target.listed ?? (await newRemoteHost(ctx, target.address, key, agent));

  const steps = stepsFor(host.kind);
  const finished = steps.every((s) => host.done.includes(s));
  const resume = resumeCommand(host);
  // A remote's first connection tests its answers: the next run offers to change them.
  const next = (s: InstallStep): string => s === "vm" && host.kind === "remote"
    ? `the next ${resume} offers to try again or to change these answers.`
    : `run ${resume} to resume there.`;
  const outcomes: [InstallStep, Outcome][] = [];
  // Not a step of this host's kind: neither run nor shown. Skipped when
  // recorded (unless `always`), recorded when it succeeds. A failure names the
  // step and the command that resumes there.
  const step = async (s: InstallStep, run: () => Promise<Outcome>, always = false): Promise<void> => {
    if (!steps.includes(s)) return;
    if (!always && host.done.includes(s)) { outcomes.push([s, "already there"]); return; }
    let outcome: Outcome;
    try {
      outcome = await run();
    } catch (e) {
      if (!(e instanceof ForgeError)) throw e;
      throw new ForgeError(`${e.message}\nThe ${label(s, host.kind)} step failed: ${next(s)}`);
    }
    host.done = steps.filter((x) => x === s || host.done.includes(x));
    saveHost(host);
    outcomes.push([s, outcome]);
  };

  // 5-6. The machine: the Lima VM (started again when it is stopped, after a
  // reboot), the cloud VM OpenTofu creates, or the remote's first connection.
  // A cloud host's runs every time: OpenTofu applies what start and stop
  // refuse (a changed infra/aws), and starts a VM the idle alarm stopped.
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const reached = host.done.includes("vm");
  const machine = (): Promise<Outcome> => (host.kind === "lima" ? limaVm(ctx, host, checkout, opts.lima)
    : host.kind === "cloud" ? cloudVm(ctx, host, checkout, sleep, reached)
    : firstConnection(ctx, host, host.address));
  await step("vm", machine, host.kind === "cloud" || (vm !== null && vm.status !== "Running"));
  // 7. Every run, so that a deleted inventory comes back; an existing one is
  // kept, with the developer's edits. A cloud host's also sets up the agent,
  // and its relay has one of its own.
  await step("inventory", async () => {
    const text = renderInventory(host, {
      forgeKey: key, adminKeyFile: host.adminKey, knownHosts: knownHostsPath(),
      ...(host.kind === "cloud" ? { contributor: contributorVars(host.name) } : {}),
    });
    const dev = writeInventoryOnce(inventoryPath(host.name), text);
    const relay = host.kind === "cloud" ? await relayInventory(ctx, host, checkout) : "kept";
    return dev === "written" || relay === "written" ? "done" : "already there";
  }, true);
  // 8. On a finished host, or on a checkout that moved since the playbook last
  // deployed it (a git pull after a failed step), the update's steps are run
  // and recorded again. A HEAD that cannot be read counts as moved.
  const head = await checkoutHead(ctx, checkout);
  if (finished || (host.done.includes("playbook") && (!head || head !== host.deployed))) {
    const update = UPDATE.filter((s) => steps.includes(s));
    host.done = host.done.filter((s) => !update.includes(s));
    saveHost(host);
  }
  await step("playbook", async () => {
    await playbook(ctx, host, checkout);
    if (head) host.deployed = head; else delete host.deployed;
    return "done";
  });
  // 9. Every run: forge's file follows the list of hosts.
  await step("ssh", () => sshConfig(ctx, host), true);
  // 10. The host's account and runtime, over the alias.
  await step("identity", async () => ((await ensureGitIdentity(ctx, host)) === "set" ? "done" : "already there"));
  await step("claude", async () => (host.kind === "cloud"
    ? ((await ensureClaudeToken(ctx, host)) === "stored" ? "done" : "already there")
    : ((await ensureClaudeLogin(ctx, host)) === "logged-in" ? "done" : "already there")));
  await step("setup", async () => { await runSetup(ctx, host); return "done"; });
  await step("image", async () => ((await ensureImage(ctx, host, checkout)) === "built" ? "done" : "already there"));
  // A cloud host's relay: the bot's token, then its setup, as the admin.
  await step("relay", async () => ((await ensureRelayCredentials(ctx, host)) === "stored" ? "done" : "already there"));
  // 11. Not recorded steps: asked while the link, or herdr's notifications,
  // are missing.
  await linkForge(ctx, checkout);
  const toasts = await herdrToasts(ctx);

  // 12. What was done, what was already there; then herdr.
  ctx.out(`${host.name}:`);
  for (const [s, outcome] of outcomes) ctx.out(`  ${label(s, host.kind)}: ${outcome}`);
  ctx.out(`  herdr notifications: ${toasts}`);
  return cmdOpen(ctx, { host: host.name });
}

// No option: forge-local when it is listed or nothing is (a first install),
// else a question: never a VM nobody asked for. --host: an installed host, of
// any kind. --remote: the installed remote with that address, or a new one.
// `cloud`: a new cloud host, whose address OpenTofu gives.
async function whichHost(ctx: Context, opts: InstallOptions): Promise<Target> {
  if (opts.remote !== undefined && opts.host !== undefined) {
    throw new ForgeError("--remote and --host do not go together: --remote <address> for a new host, --host <name> for an installed one");
  }
  if (opts.host !== undefined) {
    const listed = await selectHost(ctx, opts.host);
    return { kind: listed.kind, listed, address: listed.address };
  }
  if (opts.cloud) return { kind: "cloud", address: "" };
  const hosts = loadHosts();
  if (opts.remote !== undefined) {
    if (!ADDRESS.test(opts.remote)) throw new ForgeError(`--remote takes a host name or an IP address, not ${opts.remote}`);
    // A second, remote entry for a cloud VM would forward the SSH agent to it.
    const cloud = hosts.find((h) => h.kind === "cloud" && h.address === opts.remote);
    if (cloud) {
      throw new ForgeError(`${opts.remote} is the cloud host ${cloud.name}: ${resumeCommand(cloud)} updates it`);
    }
    return { kind: "remote", listed: hosts.find((h) => h.kind === "remote" && h.address === opts.remote), address: opts.remote };
  }
  const local = hosts.find((h) => h.name === LIMA_NAME);
  if (local || hosts.length === 0) return { kind: "lima", listed: local, address: "127.0.0.1" };
  const i = await ctx.prompt.pick("Install or update which host?", [...hosts.map((h) => h.name), `a new local VM (${LIMA_NAME})`]);
  if (i === null) {
    throw new ForgeError("no host chosen: pass --host <name> for an installed host, or --remote <address> for a new remote one");
  }
  return i <= hosts.length ? { kind: hosts[i - 1].kind, listed: hosts[i - 1], address: hosts[i - 1].address } : { kind: "lima", address: "127.0.0.1" };
}

// The commit the playbook deploys; "" when the checkout cannot tell (not a git checkout).
async function checkoutHead(ctx: Context, checkout: string): Promise<string> {
  const r = await ctx.exec(["git", "-C", checkout, "rev-parse", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : "";
}

// The key GitHub accepts, which is also the forge user's only key on the host.
// A re-run reads it back from the host's directory and asks nothing.
async function forgeKey(ctx: Context, listed?: LaptopHost): Promise<{ key: string; agent?: string }> {
  if (listed) {
    let saved = "";
    try { saved = readFileSync(forgeKeyPath(listed.name), "utf8").trim(); } catch { /* chosen again below */ }
    if (saved) return { key: saved, agent: listed.identityAgent };
  }
  const agent = listed ? listed.identityAgent : await githubAgent(ctx);
  const key = await chooseKey(ctx, await listAgentKeys(ctx, agent));
  if (listed) writeKey(listed.name, key);
  return { key, agent };
}

// A public key: 0644, in the host's 0700 directory.
function writeKey(name: string, key: string): void {
  mkdirSync(hostDir(name), { recursive: true, mode: 0o700 });
  writeFileSync(forgeKeyPath(name), `${key}\n`, { mode: 0o644 });
  chmodSync(forgeKeyPath(name), 0o644); // the umask may have narrowed the mode above
}

function saveNewHost(host: LaptopHost, key: string): void {
  saveHost(host);
  writeKey(host.name, key);
}

// Only the forge-local forge created. A listed VM deleted by hand is, on
// request, forgotten and installed again.
async function limaHost(
  ctx: Context, listed: LaptopHost | undefined, key: string, agent: string | undefined,
): Promise<{ host: LaptopHost; vm: LimaInstance | null }> {
  const vm = await limaInstance(ctx, LIMA_NAME);
  if (!listed && vm) {
    throw new ForgeError(
      `a Lima VM named ${LIMA_NAME} exists, but forge install did not create it. Retrieve its work first ` +
      `(its workspaces live inside it), then remove it with limactl delete ${LIMA_NAME} and run forge install again.`,
    );
  }
  // A VM that was never created (its creation failed) is simply created.
  if (listed && !vm && listed.done.includes("vm")) {
    const i = await ctx.prompt.pick(`${LIMA_NAME}'s Lima VM is gone`, ["forget it and install a new one", "stop"]);
    if (i !== 1) throw new ForgeError(`${LIMA_NAME} stays listed: run forge install again to forget it and start over`);
    await forgetLimaHost(ctx, listed);
    listed = undefined;
  }
  if (listed) return { host: listed, vm };
  await refuseHandDefined(ctx, LIMA_NAME);
  // Port and admin are placeholders until ensureLimaVm reads them back.
  const host: LaptopHost = {
    name: LIMA_NAME, kind: "lima", address: "127.0.0.1", port: LIMA_DEFAULT_PORT, user: "forge", admin: "",
    adminKey: join(limaHome(), "_config", "user"), exposure: "local", ...(agent ? { identityAgent: agent } : {}),
    done: [],
  };
  saveNewHost(host, key);
  return { host, vm };
}

// Its host keys (the new VM has new ones, which accept-new would refuse under
// the old names), then its directory and entry: a failure halfway leaves it
// listed, and the next run offers to forget it again.
async function forgetLimaHost(ctx: Context, host: LaptopHost): Promise<void> {
  await forgetHostKeys(ctx, [host.name, HOST_KEY_ALIAS, `[${host.address}]:${host.port}`]);
  forgetEntry(host.name);
}

// A remote whose first connection never succeeded: nothing exists on it yet,
// and its answers (admin account, key) may be what failed. Forgetting them
// removes its entry and its directory (its key), nothing else.
async function retryOrForget(ctx: Context, host: LaptopHost): Promise<void> {
  const i = await ctx.prompt.pick(`${host.name}: the first connection never succeeded`, [
    `try again with the saved answers (admin ${host.admin}, key ${host.adminKey})`, "forget these answers",
  ]);
  if (i !== 2) return;
  forgetEntry(host.name);
  throw new ForgeError(`${host.name}'s answers are forgotten: run forge install --remote ${host.address} to answer again`);
}

// Its directory (inventory and key), its entry, and its block in forge's SSH
// file when that file exists. Never for a cloud host: its directory holds the
// OpenTofu state, without which its AWS resources could not be stopped or
// destroyed.
function forgetEntry(name: string): void {
  rmSync(hostDir(name), { recursive: true, force: true });
  forgetHost(name);
  if (existsSync(forgeSshConfigPath())) writeSshFile();
}

// forge's own file follows hosts.json: one block per host whose machine was
// reached (a remote whose first connection failed has no alias yet).
function writeSshFile(): void {
  const reached = loadHosts().filter((h) => h.done.includes("vm"));
  writeForgeSshConfig(renderForgeSshConfig(reached, { knownHosts: knownHostsPath(), keyPath: forgeKeyPath }));
}

// forge never touches a host it did not create: a Host block someone else
// wrote for this name stops the run (unless forge's own file has it, R7).
async function refuseHandDefined(ctx: Context, name: string): Promise<void> {
  if (!forgeSshConfigDefines(name) && (await hostDefinedElsewhere(ctx, name))) {
    throw new ForgeError(
      `Host ${name} is already defined in your SSH configuration (~/.ssh/config or a file it includes), not by forge: remove that entry`,
    );
  }
}

// A new host's name, forge-<name>: free, and no Host block of the developer's.
async function askHostName(ctx: Context): Promise<string> {
  const answer = (await ctx.prompt.ask("Host name: forge-<name>"))?.trim();
  if (!answer) throw new ForgeError("a remote host needs a name: forge-<name>, as forge-acme");
  const name = answer.startsWith("forge-") ? answer : `forge-${answer}`;
  if (!validHostName(name)) {
    throw new ForgeError(`${name} is not a valid host name: forge- then lowercase letters, digits and dashes, as forge-acme`);
  }
  if (name === LIMA_NAME) throw new ForgeError(`${LIMA_NAME} is the local VM's name: choose another one`);
  if (loadHosts().some((h) => h.name === name)) {
    throw new ForgeError(`${name} is already installed: forge install --host ${name} updates it`);
  }
  await refuseHandDefined(ctx, name);
  return name;
}

async function askForgeUser(ctx: Context, admin: string): Promise<string> {
  const login = userInfo().username;
  const user = (await ctx.prompt.ask(`Forge user name (default ${login})`))?.trim() || login;
  if (!USER_NAME.test(user)) throw new ForgeError(`${user} is not a valid user name: lowercase letters, digits, _ and -`);
  if (user === admin) throw new ForgeError(`the forge user must differ from the admin account (${admin})`);
  return user;
}

// What a remote host needs and forge cannot guess, asked once.
async function newRemoteHost(ctx: Context, address: string, key: string, agent: string | undefined): Promise<LaptopHost> {
  const name = await askHostName(ctx);
  const admin = (await ctx.prompt.ask("Admin account (default ubuntu)"))?.trim() || "ubuntu";
  if (!USER_NAME.test(admin)) throw new ForgeError(`${admin} is not a valid account name`);
  const exposure = await ctx.prompt.pick("Exposure", ["public: a cloud VM with a public address", "lan: a machine on your network"]);
  if (exposure === null) throw new ForgeError("no exposure chosen: public or lan");
  const user = await askForgeUser(ctx, admin);
  const host: LaptopHost = {
    name, kind: "remote", address, port: 22, user, admin, adminKey: await adminKey(ctx, name, key),
    exposure: exposure === 1 ? "public" : "lan", ...(agent ? { identityAgent: agent } : {}), done: [],
  };
  saveNewHost(host, key);
  return host;
}

// A cloud host: its name, its forge user and its cloud settings, asked once
// and saved before anything is created. The admin account accepts the GitHub
// key (OpenTofu installs its public half); the address comes from OpenTofu.
async function newCloudHost(ctx: Context, key: string, agent: string | undefined): Promise<LaptopHost> {
  const name = await askHostName(ctx);
  const user = await askForgeUser(ctx, CLOUD_ADMIN);
  const settings = await askCloudSettings(ctx);
  const host: LaptopHost = {
    name, kind: "cloud", address: "", port: 22, user, admin: CLOUD_ADMIN, adminKey: forgeKeyPath(name),
    exposure: "public", ...(agent ? { identityAgent: agent } : {}), done: [],
  };
  saveCloudSettings(name, settings);
  saveNewHost(host, key);
  return host;
}

// The agent's repositories and the bot's git identity, from the cloud settings.
function contributorVars(name: string): { upstream: string; fork: string; gitName: string; gitEmail: string } {
  const s = loadCloudSettings(name);
  return { upstream: s.upstream, fork: s.fork, gitName: s.botName, gitEmail: s.botEmail };
}

// The relay's inventory, written once. Its trusted logins are asked the first
// time, and saved with the cloud settings (a host created before the relay
// existed has none); the dev VM's subnet comes from OpenTofu.
async function relayInventory(ctx: Context, host: LaptopHost, checkout: string): Promise<"written" | "kept"> {
  const path = relayInventoryPath(host.name);
  if (existsSync(path)) return "kept";
  let settings = loadCloudSettings(host.name);
  if (!settings.trustedLogins) {
    settings = { ...settings, ...(await askRelaySettings(ctx)) };
    saveCloudSettings(host.name, settings);
  }
  const { subnetCidr } = await infraOutputs(ctx, infraFor(host.name, checkout));
  return writeInventoryOnce(path, renderRelayInventory(host, settings, {
    adminKeyFile: host.adminKey, knownHosts: knownHostsPath(), subnetCidr,
  }));
}

// The GitHub key (its public half, which IdentityFile names while the private
// half stays in the agent), or a private key file the provider generated.
async function adminKey(ctx: Context, name: string, key: string): Promise<string> {
  const i = await ctx.prompt.pick("Key the admin account accepts", [keyLabel(key), "a private key file"]);
  if (i !== 2) return forgeKeyPath(name);
  const answer = (await ctx.prompt.ask("Private key file"))?.trim();
  if (!answer) throw new ForgeError("no private key file given");
  const path = resolve(answer.startsWith("~/") ? join(forgeHome(), answer.slice(2)) : answer);
  if (!existsSync(path) || !statSync(path).isFile()) throw new ForgeError(`${path}: no such key file`);
  return path;
}

async function limaVm(ctx: Context, host: LaptopHost, checkout: string, lima?: LimaOptions): Promise<Outcome> {
  const vm = await ensureLimaVm(ctx, join(checkout, "ansible", "lima", "forge.yaml"), lima);
  // Lima names its admin after the laptop login, which may be forge.
  if (vm.admin === host.user) {
    throw new ForgeError(`${LIMA_NAME}'s admin account is ${vm.admin}, the name of the forge user it would create: the two must differ`);
  }
  Object.assign(host, { port: vm.port, admin: vm.admin, adminKey: vm.adminKey });
  return "done";
}

// The cloud VMs, the dev VM and its relay: checked for nested
// virtualization, then created (or updated, or found unchanged) by OpenTofu,
// which shows its plan and asks (an empty plan asks nothing); SSH is opened
// to this machine's current address only. Then, once each sshd answers, its
// first connection, as for a remote, unless an earlier run made it. Run on
// every install: OpenTofu's state knows what exists. An instance's metadata
// service stays on until its first connection: cloud-init reads the admin
// key from it on the first boot. The dev VM was reached once its VM step was
// recorded (`reached`); the relay, once forge's known_hosts has its key,
// which a host installed before the relay existed, or a rebuilt relay
// (rebuild-relay forgets it), does not have.
async function cloudVm(
  ctx: Context, host: LaptopHost, checkout: string, sleep: (ms: number) => Promise<void>, reached: boolean,
): Promise<Outcome> {
  const settings = loadCloudSettings(host.name);
  await checkNestedVirt(ctx, settings);
  saveCloudSettings(host.name, { ...settings, sshCidr: `${await currentPublicIp(ctx)}/32` });
  const infra = infraFor(host.name, checkout);
  const before = host.relayAddress;
  const known = await relayReached(ctx, host);
  await applyInteractive(ctx, infra, { dev: !reached, relay: !known });
  const outputs = await infraOutputs(ctx, infra);
  host.address = outputs.address;
  host.relayAddress = outputs.relayAddress;
  await waitForSsh(ctx, host, host.address, sleep, reached);
  if (!reached) await firstConnection(ctx, host, host.address);
  // An Elastic IP keeps its address; a new one has no key in known_hosts yet.
  const relayKnown = known && host.relayAddress === before;
  try {
    await waitForSsh(ctx, host, host.relayAddress, sleep, relayKnown);
    if (!relayKnown) await firstConnection(ctx, host, host.relayAddress);
  } catch (e) {
    // A key forge holds for a relay that no longer has it (replaced by hand,
    // or rebuild-relay interrupted before it forgot the old key) refuses
    // every connection: forge's own way out is a new relay.
    if (!(e instanceof ForgeError) || (await hostKeys(ctx, host.relayAddress)).length === 0) throw e;
    throw new ForgeError(
      `${e.message}\n${knownHostsPath()} holds a key for ${host.name}'s relay (${host.relayAddress}): if the relay ` +
      `was replaced or its key changed, forge cloud rebuild-relay --host ${host.name} replaces it and forgets that key`,
    );
  }
  return "done";
}

// Whether the relay was reached: its recorded address has a key in forge's
// known_hosts. A host installed before the relay existed has no address, and
// rebuild-relay forgets the key: their relay's metadata service is on until
// its first connection, as a new instance's (cloud-init reads the admin key
// from it), whatever the command that applies OpenTofu.
export async function relayReached(ctx: Context, host: LaptopHost): Promise<boolean> {
  return host.relayAddress !== undefined && (await hostKeys(ctx, host.relayAddress)).length > 0;
}

// The keys forge's known_hosts holds for `address`, as `<type> <base64>`.
// `ssh-keygen -F` prints a comment, then each matching line (its host field
// hashed or not); a marked line (@revoked, @cert-authority) is no host's key.
async function hostKeys(ctx: Context, address: string): Promise<string[]> {
  if (!existsSync(knownHostsPath())) return [];
  const r = await ctx.exec(["ssh-keygen", "-F", address, "-f", knownHostsPath()]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").flatMap((l) => {
    const [hostField, type, key] = l.trim().split(/\s+/);
    return hostField && !hostField.startsWith("#") && !hostField.startsWith("@") && type && key ? [`${type} ${key}`] : [];
  });
}

// The relay's host key for the dev VM, which trusts it by this key alone (no
// first use there): the one ssh recorded at the relay's first connection,
// `ssh-ed25519 <base64>` and nothing else.
async function relayHostKey(ctx: Context, host: LaptopHost): Promise<string> {
  const address = host.relayAddress ?? "no address yet";
  const keys = host.relayAddress ? await hostKeys(ctx, host.relayAddress) : [];
  const key = keys.find((k) => /^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(k));
  if (key) return key;
  // Another type only: ssh asks no question about a known host, so a re-run
  // would never record the ed25519 key.
  if (keys.length > 0) {
    throw new ForgeError(
      `${knownHostsPath()} holds keys for ${host.name}'s relay (${address}), but no ssh-ed25519 one, which the dev VM ` +
      `pins: remove them (ssh-keygen -R ${address} -f ${knownHostsPath()}), then run forge cloud create --host ${host.name} ` +
      "again, which connects to the relay and records its key",
    );
  }
  throw new ForgeError(
    `${knownHostsPath()} holds no key for ${host.name}'s relay (${address}): ` +
    `run forge cloud create --host ${host.name} again, which connects to the relay and records it`,
  );
}

// A new instance boots for a minute or two before sshd answers. The keys
// ssh-keyscan prints only say it does: the first connection asks about them.
// Once the machine was reached, the probe is the admin's login instead: on a
// public host, fail2ban's aggressive mode counts ssh-keyscan's connections,
// closed before authentication, and bans this machine after three of them.
async function waitForSsh(
  ctx: Context, host: LaptopHost, address: string, sleep: (ms: number) => Promise<void>, reached: boolean,
): Promise<void> {
  for (let i = 0; i < SSH_TRIES; i++) {
    if (i > 0) await sleep(SSH_WAIT_MS);
    if (reached) {
      if ((await ctx.exec(adminSsh(host, address, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"]))).code === 0) return;
    } else {
      const r = await ctx.exec(["ssh-keyscan", "-T", "5", address]);
      if (r.stdout.split("\n").some((l) => l.trim() !== "" && !l.startsWith("#"))) return;
    }
  }
  throw new ForgeError(
    `${address} did not answer on SSH within ${(SSH_TRIES * SSH_WAIT_MS) / 60000} minutes: ` +
    "check the instance in the AWS console, and that this machine's public address has not changed",
  );
}

// In the terminal, so that OpenSSH asks about the new machine's key once, in
// the open; exactly one key is offered (sshd allows two attempts, fail2ban bans).
async function firstConnection(ctx: Context, host: LaptopHost, address: string): Promise<Outcome> {
  mkdirSync(dirname(knownHostsPath()), { recursive: true, mode: 0o700 });
  const code = await ctx.attach(adminSsh(host, address));
  if (code !== 0) {
    throw new ForgeError(`ssh ${host.admin}@${address} failed (exit code ${code}): check the address, the admin account and its key`);
  }
  return "done";
}

// From the checkout, whose HEAD the playbook deploys (its directory too: an
// ansible.cfg wherever forge was run from is never read); the collections
// live in forge's data directory. A cloud host's playbook is site.yml plus the
// agent's role, then its relay's.
async function playbook(ctx: Context, host: LaptopHost, checkout: string): Promise<void> {
  const collections = join(laptopDataDir(), "collections");
  const opts = { env: { ANSIBLE_COLLECTIONS_PATH: collections }, cwd: checkout };
  const requirements = join(checkout, "ansible", "requirements.yml");
  const galaxy = await ctx.attach(["ansible-galaxy", "collection", "install", "-r", requirements, "-p", collections], opts);
  if (galaxy !== 0) throw new ForgeError(`ansible-galaxy collection install failed (exit code ${galaxy})`);
  const run = async (inventory: string, file: string, ...extra: string[]): Promise<void> => {
    const play = await ctx.attach(["ansible-playbook", "-i", inventory, join(checkout, "ansible", file), ...extra], opts);
    if (play !== 0) throw new ForgeError(`ansible-playbook ${file} failed (exit code ${play})`);
  };
  if (host.kind !== "cloud") return run(inventoryPath(host.name), "site.yml");
  // contributor.yml makes the dev VM's relay client key and fetches its public
  // half to this machine; relay.yml lets that key in. The key file goes as
  // JSON: Ansible's key=value form would cut a path at a space.
  await run(inventoryPath(host.name), "contributor.yml", "-e", `@${await writeRelayLink(ctx, host, checkout)}`);
  await run(relayInventoryPath(host.name), "relay.yml",
    "-e", JSON.stringify({ forge_relay_client_key_file: relayClientKeyPath(host.name) }));
}

// What contributor.yml needs about the relay, all of it public: its private
// address (the dev VM's way to it), its host key, and where to put the dev
// VM's client key on this machine. Written on each run, from OpenTofu and
// known_hosts; returns its path.
async function writeRelayLink(ctx: Context, host: LaptopHost, checkout: string): Promise<string> {
  const { relayPrivateIp } = await infraOutputs(ctx, infraFor(host.name, checkout));
  const link = {
    forge_contributor_relay_address: relayPrivateIp,
    forge_contributor_relay_host_key: await relayHostKey(ctx, host),
    forge_contributor_relay_client_pub_dest: relayClientKeyPath(host.name),
  };
  const path = relayLinkPath(host.name);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(link, null, 2) + "\n", { mode: 0o600 });
  return path;
}

// forge's own file is rewritten freely. ~/.ssh/config is left alone when an
// Include of the developer's already reads that file for every host and
// `ssh -G` shows forge's values in effect; otherwise it gains the one Include,
// at its top, after a confirmation. The old config.d/agent-forge goes only
// once ssh is known to read the new file: until then it keeps the alias
// working.
async function sshConfig(ctx: Context, host: LaptopHost): Promise<Outcome> {
  // Checked again: a block may have been written by hand since the install began.
  await refuseHandDefined(ctx, host.name);
  writeSshFile();
  const path = join(sshDir(), "config");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (includeState(text) === "covered") {
    const overridden = await overriddenSettings(ctx, host, { knownHosts: knownHostsPath(), keyPath: forgeKeyPath });
    if (overridden.length === 0) {
      removeOldForgeSshConfig();
      return host.done.includes("ssh") ? "already there" : "done";
    }
    // Settings read before forge's file win over its block (ssh keeps the
    // first value): with the Include at the top, forge's values come first.
    for (const line of overridden) ctx.out(line);
    ctx.out(`With ${INCLUDE_LINE} at the top of ~/.ssh/config, ssh reads forge's file first and forge's values win.`);
    await addIncludeOrStop(ctx, path, text,
      `the alias ${host.name} would not work as installed: settings of your SSH configuration win over forge's (above). ` +
      `Add ${INCLUDE_LINE} at the top of ~/.ssh/config, or answer yes on the next forge install`);
  } else {
    await addIncludeOrStop(ctx, path, text,
      `without ${INCLUDE_LINE} at the top of ~/.ssh/config (or an Include of yours that reads it for every host), ` +
      `ssh never reads forge's file: the alias ${host.name} cannot work`);
  }
  removeOldForgeSshConfig();
  return "done";
}

// The one Include, at the top of ~/.ssh/config, after a confirmation; a
// refusal stops the run with `refusal`.
async function addIncludeOrStop(ctx: Context, path: string, text: string, refusal: string): Promise<void> {
  const yes = await ctx.prompt.pick(`Add \`${INCLUDE_LINE}\` at the top of ~/.ssh/config?`, ["yes", "no"]);
  if (yes !== 1) throw new ForgeError(refusal);
  writeKeepingMode(path, addInclude(text));
}

// Atomic, next to the real file (a symlinked ~/.ssh/config stays a symlink),
// with its mode kept; a new file is 0600.
function writeKeepingMode(path: string, text: string): void {
  const target = existsSync(path) ? realpathSync(path) : path;
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
  const tmp = `${target}.forge-tmp`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, target);
}

// herdr draws a notification, the start popup's warnings among them, only if
// the laptop's herdr config turns toasts on (spec, sub-project 1, Finding):
// forge's laptop block, after a confirmation, unless the developer's config
// sets them itself. Declining is not an error.
async function herdrToasts(ctx: Context): Promise<string> {
  const path = herdrConfigPath();
  let text: string;
  let state: ReturnType<typeof laptopToasts>;
  try {
    text = readConfig(path);
    state = laptopToasts(text);
  } catch (e) {
    ctx.out(`${path}: ${(e as Error).message}; herdr's notifications left as they are`);
    return "left as they are";
  }
  if (state === "forge") return "already there";
  // The developer's own toasts, already delivered by herdr: nothing to say.
  if (state === "user-on") return "set in your config";
  if (state === "user") {
    ctx.out(`${path} sets [ui.toast] or ui = {…}: forge leaves it alone. herdr's toasts must be on ` +
      `(delivery = "herdr") for the start popup's warnings to show.`);
    return "set in your config";
  }
  if ((await ctx.prompt.pick(`Turn herdr's notifications on in ${path}?`, ["yes", "no"])) !== 1) {
    ctx.out("herdr's notifications stay as they are: with them off, the start popup's warnings will go unseen.");
    return "declined";
  }
  try {
    addLaptopBlock(path, text);
  } catch (e) {
    ctx.out(`${path}: ${(e as Error).message}; herdr's notifications left as they are`);
    return "left as they are";
  }
  return "done";
}

// ~/.local/bin/forge → the checkout's cli/forge, after a confirmation; any
// other file there is left alone.
async function linkForge(ctx: Context, checkout: string): Promise<void> {
  const bin = join(forgeHome(), ".local", "bin");
  const link = join(bin, "forge");
  const target = join(checkout, "cli", "forge");
  let present = true;
  try { lstatSync(link); } catch { present = false; }
  if (!present) {
    if ((await ctx.prompt.pick(`Link ~/.local/bin/forge to ${target}?`, ["yes", "no"])) !== 1) return;
    mkdirSync(bin, { recursive: true });
    symlinkSync(target, link);
  } else if (!lstatSync(link).isSymbolicLink() || resolve(bin, readlinkSync(link)) !== target) {
    ctx.out(`~/.local/bin/forge is not a link to ${target}: left as it is`);
    return;
  }
  const onPath = (process.env.PATH ?? "").split(":").some((d) => d !== "" && resolve(d) === bin);
  if (!onPath) {
    ctx.out("~/.local/bin is not on your PATH: add this line to your shell's rc file (~/.zshrc, ~/.bashrc):");
    ctx.out('export PATH="$HOME/.local/bin:$PATH"');
  }
}
