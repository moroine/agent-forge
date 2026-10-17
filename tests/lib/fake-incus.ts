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
};
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
  "list", "info", "launch", "start", "stop", "delete", "config", "exec", "file", "publish", "image", "profile",
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

export class FakeIncus {
  readonly calls: FakeCall[] = [];
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
          ? ok(JSON.stringify({ api_version: "1.0", environment: { firewall: this.firewall, server_version: "7.0.1" } }))
          : unsupported(argv);
      case "list": return ok(JSON.stringify([...this.instances.get(p)!.values()]));
      case "info": return this.instances.get(p)!.has(rest[0]) ? ok(`Name: ${rest[0]}\n`) : fail("Instance not found");
      case "launch": return this.launch(p, rest);
      case "start": return this.setStatus(p, rest[0], "Running");
      case "stop": return this.setStatus(p, rest[0], "Stopped");
      case "delete": return this.deleteInstance(p, rest);
      case "config": return this.config(p, rest);
      case "exec": return this.exec(p, rest);
      case "file": return rest[0] === "push" ? ok() : unsupported(argv);
      case "publish": return this.publish(p, rest);
      case "image": return this.image(p, rest);
      default: return unsupported(argv);
    }
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
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] !== "--profile") return fail(`fake incus: unsupported launch flag ${flags[i]}`);
      profiles.push(flags[++i]);
    }
    if (this.instances.get(p)!.has(name)) return fail(`Instance "${name}" already exists`);
    if (!image.startsWith("images:") && !this.findImage(p, image)) return fail("Image not found");
    for (const profile of profiles) {
      if (!this.profiles.get(p)!.has(profile)) return fail(`Profile "${profile}" not found`);
    }
    this.instances.get(p)!.set(name, { name, status: "Running", profiles, config: {}, devices: {} });
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
      inst.config[key] = value;
      return ok();
    }
    return unsupported(["config", ...rest]);
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
