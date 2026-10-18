// In-memory model of the `incus` CLI for unit tests, successor of the former stub.
// A rule table (fake-context.ts) answers one call at a time; this model keeps
// state, which `forge setup` and `forge image build` need: what one call
// creates, the next `list -f json` must show. It models what forge relies on:
//   - instance, profile and image commands require --project, so a call that
//     forgets it fails here instead of silently hitting the default project;
//   - `create` and `edit` of projects, networks, ACLs and profiles read the
//     object from stdin, and an empty stdin replaces it with an empty object,
//     as the real CLI does (spike, finding C);
//   - `list -f json` is served from the state, in Incus' own shape: ACL rules
//     with every field present, unmanaged host interfaces in `network list`,
//     default features filled in on `project create`;
//   - every call is recorded with its stdin.
// Anything it does not model fails with exit code 1, so that a test never
// passes on a command the fake silently ignored.
import { readFileSync } from "node:fs";
import type { ExecResult } from "../../cli/lib/context.ts";

export type Config = Record<string, string>;
export type Devices = Record<string, Record<string, string>>;
export type ProjectState = { name: string; description: string; config: Config };
export type NetworkState = { name: string; description: string; config: Config; type: string; managed: boolean };
export type AclRule = Record<string, string>;
export type AclState = { name: string; description: string; config: Config; ingress: AclRule[]; egress: AclRule[] };
export type ProfileState = { name: string; description: string; config: Config; devices: Devices };
export type InstanceState = {
  name: string; status: "Running" | "Stopped"; profiles: string[]; config: Config; devices: Devices;
  // The address `list -f json` reports for eth0.
  ipv4?: string;
};
export type FileState = { content: string; uid: string; gid: string; mode: string };
export type ImageState = { fingerprint: string; aliases: { name: string; description: string }[]; properties: Config };
export type FakeCall = { argv: string[]; input: string | undefined };

// Fields Incus returns for every ACL rule, empty ones included.
const RULE_FIELDS = ["action", "state", "description", "source", "destination", "protocol",
  "source_port", "destination_port", "icmp_type", "icmp_code"];

// Features Incus sets on `project create` when the request leaves them out.
const DEFAULT_FEATURES: Config = {
  "features.images": "true",
  "features.profiles": "true",
  "features.storage.volumes": "true",
  "features.storage.buckets": "true",
  "features.networks": "false",
  "features.networks.zones": "false",
};

// The commands that act on project-scoped objects (spec "Testing").
const NEEDS_PROJECT = new Set([
  "list", "info", "launch", "start", "stop", "restart", "delete", "config", "exec", "file", "publish", "image", "profile",
]);

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (message: string): ExecResult => ({ code: 1, stdout: "", stderr: `Error: ${message}\n` });
const unsupported = (argv: string[]) => fail(`fake incus: unsupported command: incus ${argv.join(" ")}`);

const emptyProfile = (name: string): ProfileState => ({ name, description: "", config: {}, devices: {} });
const asString = (v: unknown): string => (typeof v === "string" ? v : "");
const asConfig = (v: unknown): Config =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)]))
    : {};
const asDevices = (v: unknown): Devices =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).map(([k, d]) => [k, asConfig(d)]))
    : {};
const asRules = (v: unknown): AclRule[] =>
  (Array.isArray(v) ? v : []).map((r) =>
    Object.fromEntries(RULE_FIELDS.map((f) => [f, String((r as Record<string, unknown>)?.[f] ?? "")])));

type Parsed = { ok: true; body: Record<string, unknown> } | { ok: false; error: ExecResult };

// stdin → object. An empty stdin is an empty object: that is what wipes.
function parseBody(input: string | undefined): Parsed {
  if (input === undefined || input.trim() === "") return { ok: true, body: {} };
  try {
    const parsed: unknown = JSON.parse(input);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: fail("yaml: cannot unmarshal into an object") };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: fail("fake incus: stdin is not JSON (the real CLI takes YAML, a superset)") };
  }
}

// "k=v" → [k, v]; the value may contain "=".
const splitPair = (kv: string): [string, string] => {
  const i = kv.indexOf("=");
  return i < 0 ? [kv, ""] : [kv.slice(0, i), kv.slice(i + 1)];
};

export class FakeIncus {
  readonly calls: FakeCall[] = [];
  // Incus 7.0.1 removes the image that held the alias on `publish --reuse`; set to
  // true to model an Incus that keeps it.
  publishReuseKeepsOld = false;
  serverVersion = "7.0.2";
  // Files pushed into instances, keyed "<project>/<instance><path>".
  readonly files = new Map<string, FileState>();
  readonly projects = new Map<string, ProjectState>([
    ["default", { name: "default", description: "Default Incus project", config: {} }],
  ]);
  // Networks and ACLs live in `default`: forge's project has
  // features.networks=false, so Incus resolves them there.
  readonly networks = new Map<string, NetworkState>();
  readonly acls = new Map<string, AclState>();
  readonly profiles = new Map<string, Map<string, ProfileState>>([["default", new Map([["default", emptyProfile("default")]])]]);
  readonly instances = new Map<string, Map<string, InstanceState>>([["default", new Map()]]);
  readonly images = new Map<string, ImageState[]>([["default", []]]);
  storagePools = ["default"];
  firewall = "nftables";
  hostInterfaces = ["lo", "eth0"];
  private nextFingerprint = 1;

  // What `forge setup` and `forge image build` leave behind: the project, its
  // profile and an agent-base image.
  static withRuntime(opts: { project?: string; commit?: string } = {}): FakeIncus {
    const fake = new FakeIncus();
    const project = opts.project ?? "agent-forge";
    fake.addProject(project);
    fake.addProfile(project, "agent-forge");
    fake.addImage(project, "agent-base", { "user.forge.commit": opts.commit ?? "aaaa1111" });
    return fake;
  }

  addProject(name: string, config: Config = {}): void {
    this.projects.set(name, { name, description: "", config: { ...DEFAULT_FEATURES, ...config } });
    this.profiles.set(name, new Map([["default", emptyProfile("default")]]));
    this.instances.set(name, new Map());
    this.images.set(name, []);
  }

  addProfile(project: string, name: string, profile: Partial<ProfileState> = {}): void {
    this.profiles.get(project)!.set(name, { ...emptyProfile(name), ...profile, name });
  }

  addInstance(project: string, name: string, instance: Partial<InstanceState> = {}): void {
    this.instances.get(project)!.set(name, {
      name, status: "Running", profiles: [], config: {}, devices: {}, ...instance,
    });
  }

  addImage(project: string, alias: string, properties: Config = {}): string {
    const fingerprint = `fp${this.nextFingerprint++}`;
    this.images.get(project)!.push({ fingerprint, aliases: [{ name: alias, description: "" }], properties: { ...properties } });
    return fingerprint;
  }

  findImage(project: string, ref: string): ImageState | undefined {
    return this.images.get(project)?.find((i) => i.fingerprint === ref || i.aliases.some((a) => a.name === ref));
  }

  run(argv: string[], input?: string): ExecResult {
    this.calls.push({ argv, input });
    let project: string | undefined;
    let args = argv;
    if (args[0] === "--project") {
      project = args[1];
      args = args.slice(2);
    }
    const [cmd, ...rest] = args;
    if (NEEDS_PROJECT.has(cmd) && project === undefined) {
      return fail(`fake incus: --project is required for '${cmd}'`);
    }
    if (project !== undefined && !this.projects.has(project)) return fail("Project not found");
    const p = project ?? "default";
    switch (cmd) {
      case "project": return this.project(rest, input);
      case "network": return rest[0] === "acl" ? this.acl(rest.slice(1), input) : this.network(rest, input);
      case "profile": return this.profile(p, rest, input);
      case "storage":
        return rest[0] === "list"
          ? ok(JSON.stringify(this.storagePools.map((name) => ({ name, driver: "btrfs" }))))
          : unsupported(argv);
      case "query":
        return rest[0] === "/1.0"
          ? ok(JSON.stringify({ api_version: "1.0", environment: { firewall: this.firewall, server_version: this.serverVersion } }))
          : unsupported(argv);
      case "list": return ok(JSON.stringify([...this.instances.get(p)!.values()].map((i) => this.listed(p, i))));
      case "info": return this.instances.get(p)!.has(rest[0]) ? ok(`Name: ${rest[0]}\n`) : fail("Instance not found");
      case "launch": return this.launch(p, rest);
      case "start": return this.setStatus(p, rest[0], "Running");
      case "restart": return this.setStatus(p, rest[0], "Running");
      case "stop": return this.setStatus(p, rest[0], "Stopped");
      case "delete": return this.deleteInstance(p, rest);
      case "config": return this.config(p, rest);
      case "exec": return this.exec(p, rest);
      case "file": return this.file(p, rest);
      case "publish": return this.publish(p, rest);
      case "image": return this.image(p, rest);
      default: return unsupported(argv);
    }
  }

  // Profile devices in profile order, overlaid by the instance's local devices
  // (whole-device replacement by name, as Incus does).
  expandedDevices(project: string, name: string): Devices {
    const inst = this.instances.get(project)!.get(name)!;
    const expanded: Devices = {};
    for (const profile of inst.profiles) {
      for (const [dev, conf] of Object.entries(this.profiles.get(project)?.get(profile)?.devices ?? {})) {
        expanded[dev] = { ...conf };
      }
    }
    for (const [dev, conf] of Object.entries(inst.devices)) expanded[dev] = { ...conf };
    return expanded;
  }

  // One instance as `list -f json` shows it.
  private listed(p: string, i: InstanceState): Record<string, unknown> {
    return {
      name: i.name, status: i.status, config: i.config, devices: i.devices, profiles: i.profiles,
      expanded_devices: this.expandedDevices(p, i.name),
      state: { network: { eth0: { addresses: i.ipv4 ? [{ family: "inet", address: i.ipv4 }] : [] } } },
    };
  }

  private project(rest: string[], input?: string): ExecResult {
    const [sub, name] = rest;
    if (sub === "list") {
      return ok(JSON.stringify([...this.projects.values()].map((x) => ({ ...x, used_by: [] }))));
    }
    if (sub !== "create") return unsupported(["project", ...rest]);
    if (this.projects.has(name)) return fail(`Project "${name}" already exists`);
    const parsed = parseBody(input);
    if (!parsed.ok) return parsed.error;
    this.addProject(name, asConfig(parsed.body.config));
    this.projects.get(name)!.description = asString(parsed.body.description);
    return ok();
  }

  private network(rest: string[], input?: string): ExecResult {
    const [sub, name] = rest;
    if (sub === "list") {
      const unmanaged = this.hostInterfaces.map((n) => ({
        name: n, description: "", type: n === "lo" ? "loopback" : "physical", managed: false, config: {}, used_by: [],
      }));
      const managed = [...this.networks.values()].map((x) => ({ ...x, used_by: [] }));
      return ok(JSON.stringify([...unmanaged, ...managed]));
    }
    const check = this.checkWrite(sub, name, this.networks.has(name), "Network");
    if (check) return check;
    const parsed = parseBody(input);
    if (!parsed.ok) return parsed.error;
    this.networks.set(name, {
      name, type: "bridge", managed: true,
      description: asString(parsed.body.description), config: asConfig(parsed.body.config),
    });
    return ok();
  }

  private acl(rest: string[], input?: string): ExecResult {
    const [sub, name] = rest;
    if (sub === "list") return ok(JSON.stringify([...this.acls.values()].map((x) => ({ ...x, used_by: [] }))));
    const check = this.checkWrite(sub, name, this.acls.has(name), "Network ACL");
    if (check) return check;
    const parsed = parseBody(input);
    if (!parsed.ok) return parsed.error;
    // The real ACL loader rejects unknown fields.
    const unknown = Object.keys(parsed.body).filter((k) => !["name", "description", "config", "ingress", "egress"].includes(k));
    if (unknown.length > 0) return fail(`yaml: unmarshal errors: field ${unknown[0]} not found`);
    this.acls.set(name, {
      name, description: asString(parsed.body.description), config: asConfig(parsed.body.config),
      ingress: asRules(parsed.body.ingress), egress: asRules(parsed.body.egress),
    });
    return ok();
  }

  private profile(p: string, rest: string[], input?: string): ExecResult {
    const [sub, name] = rest;
    const profiles = this.profiles.get(p)!;
    if (sub === "list") return ok(JSON.stringify([...profiles.values()].map((x) => ({ ...x, used_by: [] }))));
    const check = this.checkWrite(sub, name, profiles.has(name), "Profile");
    if (check) return check;
    const parsed = parseBody(input);
    if (!parsed.ok) return parsed.error;
    profiles.set(name, {
      name, description: asString(parsed.body.description),
      config: asConfig(parsed.body.config), devices: asDevices(parsed.body.devices),
    });
    return ok();
  }

  // create needs a new name, edit an existing one; anything else is unknown.
  private checkWrite(sub: string, name: string, exists: boolean, kind: string): ExecResult | null {
    if (sub === "create") return exists ? fail(`${kind} "${name}" already exists`) : null;
    if (sub === "edit") return exists ? null : fail(`${kind} not found`);
    return unsupported([kind.toLowerCase(), sub, name]);
  }

  private launch(p: string, rest: string[]): ExecResult {
    const [image, name, ...flags] = rest;
    const profiles: string[] = [];
    const deviceFlags: string[] = [];
    const config: Config = {};
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === "--profile") profiles.push(flags[++i]);
      else if (flags[i] === "-d") deviceFlags.push(flags[++i]);
      else if (flags[i] === "-c") {
        const [k, v] = splitPair(flags[++i] ?? "");
        config[k] = v;
      } else return fail(`fake incus: unsupported launch flag ${flags[i]}`);
    }
    if (this.instances.get(p)!.has(name)) return fail(`Instance "${name}" already exists`);
    if (!image.startsWith("images:") && !this.findImage(p, image)) return fail("Image not found");
    for (const profile of profiles) {
      if (!this.profiles.get(p)!.has(profile)) return fail(`Profile "${profile}" not found`);
    }
    const devices: Devices = {};
    for (const flag of deviceFlags) {
      const [dev, ...pairs] = flag.split(",");
      // A local copy of the profile's device of that name, with the keys overlaid.
      const base = profiles.map((n) => this.profiles.get(p)!.get(n)!.devices[dev]).find((d) => d !== undefined);
      devices[dev] = { ...base, ...Object.fromEntries(pairs.map(splitPair)) };
    }
    this.instances.get(p)!.set(name, { name, status: "Running", profiles, config, devices });
    return ok();
  }

  private setStatus(p: string, name: string, status: "Running" | "Stopped"): ExecResult {
    const inst = this.instances.get(p)!.get(name);
    if (!inst) return fail("Instance not found");
    inst.status = status;
    return ok();
  }

  private deleteInstance(p: string, rest: string[]): ExecResult {
    const inst = this.instances.get(p)!.get(rest[0]);
    if (!inst) return fail("Instance not found");
    if (inst.status === "Running" && !rest.includes("--force")) return fail("The instance is currently running");
    this.instances.get(p)!.delete(rest[0]);
    return ok();
  }

  private config(p: string, rest: string[]): ExecResult {
    if (rest[0] === "device" && rest[1] !== "add") return this.configDevice(p, rest.slice(1));
    if (rest[0] === "device" && rest[1] === "add") {
      const [, , name, device, type, ...pairs] = rest;
      const inst = this.instances.get(p)!.get(name);
      if (!inst) return fail("Instance not found");
      inst.devices[device] = { type, ...Object.fromEntries(pairs.map((kv) => kv.split(/=(.*)/s).slice(0, 2))) };
      return ok();
    }
    const [sub, name, key, value] = rest;
    const inst = this.instances.get(p)!.get(name);
    if (!inst) return fail("Instance not found");
    if (sub === "get") return ok(`${inst.config[key] ?? ""}\n`);
    if (sub === "set") {
      // `set <i> k=v [k=v…]` or `set <i> <key> <value>`.
      if (key !== undefined && key.includes("=")) {
        for (const kv of rest.slice(2)) {
          const [k, v] = splitPair(kv);
          inst.config[k] = v;
        }
      } else inst.config[key] = value;
      return ok();
    }
    if (sub === "unset") {
      delete inst.config[key];
      return ok();
    }
    return unsupported(["config", ...rest]);
  }

  // config device override|set|remove <instance> <device> [k=v…]
  private configDevice(p: string, rest: string[]): ExecResult {
    const [sub, name, dev, ...pairs] = rest;
    const inst = this.instances.get(p)!.get(name);
    if (!inst) return fail("Instance not found");
    const keys = Object.fromEntries(pairs.map(splitPair));
    const local = inst.devices[dev];
    switch (sub) {
      case "override": {
        if (local) return fail(`The device already exists`);
        const base = this.expandedDevices(p, name)[dev];
        if (!base) return fail(`Device from profile(s) doesn't exist`);
        inst.devices[dev] = { ...base, ...keys };
        return ok();
      }
      case "set":
        if (!local) return fail(`Device doesn't exist`);
        Object.assign(local, keys);
        return ok();
      case "remove":
        if (!local) return fail(`Device doesn't exist`);
        delete inst.devices[dev];
        return ok();
      default: return unsupported(["config", "device", ...rest]);
    }
  }

  // file push <src> <instance><path> [--uid U] [--gid G] [--mode M] [--create-dirs]
  // file pull <instance><path> -
  private file(p: string, rest: string[]): ExecResult {
    const [sub, ...args] = rest;
    const target = (t: string): { name: string; key: string } | undefined => {
      const slash = t.indexOf("/");
      return slash > 0 ? { name: t.slice(0, slash), key: `${p}/${t}` } : undefined;
    };
    if (sub === "push") {
      const [src, dest, ...flags] = args;
      const t = dest === undefined ? undefined : target(dest);
      if (src === undefined || !t) return fail("fake incus: file push needs <src> <instance><path>");
      const state: FileState = { content: "", uid: "0", gid: "0", mode: "644" };
      for (let i = 0; i < flags.length; i++) {
        if (flags[i] === "--uid") state.uid = flags[++i];
        else if (flags[i] === "--gid") state.gid = flags[++i];
        else if (flags[i] === "--mode") state.mode = flags[++i];
        else if (flags[i] !== "--create-dirs") return fail(`fake incus: unsupported file push flag ${flags[i]}`);
      }
      if (!this.instances.get(p)!.has(t.name)) return fail("Instance not found");
      try {
        state.content = readFileSync(src, "utf8");
      } catch {
        return fail(`stat ${src}: no such file or directory`);
      }
      this.files.set(t.key, state);
      return ok();
    }
    if (sub === "pull" && args.length === 2 && args[1] === "-") {
      const t = target(args[0]);
      if (!t || !this.instances.get(p)!.has(t.name)) return fail("Instance not found");
      const f = this.files.get(t.key);
      return f ? ok(f.content) : fail("No such file or directory");
    }
    return unsupported(["file", ...rest]);
  }

  private exec(p: string, rest: string[]): ExecResult {
    const inst = this.instances.get(p)!.get(rest[0]);
    if (!inst) return fail("Instance not found");
    if (inst.status !== "Running") return fail("Instance is not running");
    const command = rest.slice(rest.indexOf("--") + 1).join(" ");
    if (command === "systemctl is-system-running --wait") return ok("running\n");
    return ok();
  }

  private publish(p: string, rest: string[]): ExecResult {
    const inst = this.instances.get(p)!.get(rest[0]);
    if (!inst) return fail("Instance not found");
    if (inst.status === "Running") return fail("The instance is running, stop it first");
    const alias = rest[rest.indexOf("--alias") + 1];
    const holder = this.findImage(p, alias);
    if (holder) {
      if (!rest.includes("--reuse")) return fail(`Alias "${alias}" already exists`);
      holder.aliases = holder.aliases.filter((a) => a.name !== alias);
    }
    const fingerprint = this.addImage(p, alias);
    if (holder && !this.publishReuseKeepsOld && holder.aliases.length === 0) {
      const images = this.images.get(p)!;
      images.splice(images.indexOf(holder), 1);
    }
    return ok(`Instance published with fingerprint: ${fingerprint}\n`);
  }

  private image(p: string, rest: string[]): ExecResult {
    const [sub, ref, key, value] = rest;
    const images = this.images.get(p)!;
    const img = ref === undefined ? undefined : this.findImage(p, ref);
    switch (sub) {
      case "list": return ok(JSON.stringify(images));
      case "info": return img ? ok() : fail("Image not found");
      case "get-property": return img ? ok(`${img.properties[key] ?? ""}\n`) : fail("Image not found");
      case "set-property":
        if (!img) return fail("Image not found");
        img.properties[key] = value;
        return ok();
      case "delete":
        if (!img) return fail("Image not found");
        images.splice(images.indexOf(img), 1);
        return ok();
      default: return unsupported(["image", ...rest]);
    }
  }
}
