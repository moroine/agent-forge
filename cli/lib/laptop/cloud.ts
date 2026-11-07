// Cloud settings of the dev VM and the OpenTofu driver behind `forge cloud` and
// `forge install`. OpenTofu only creates cloud objects; the state and the data
// directory live in the host's laptop state directory, never in the checkout.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ForgeError, mustSucceed, type Context } from "../context.ts";
import { parseAddress } from "../ipv4.ts";
import { forgeKeyPath, hostDir } from "./state.ts";

export type CloudSettings = {
  awsProfile: string;
  region: string;
  instanceType: string;
  diskGb: number;
  budgetUsd: number;
  alertEmail: string;
  upstream: string;
  fork: string;
  botName: string;
  botEmail: string;
  // The /32 allowed to reach SSH; `forge cloud start` sets it to this machine's address.
  sshCidr?: string;
};

export type Infra = { name: string; checkout: string; settings: CloudSettings; adminKey: string };

export const DEV_INSTANCE = "aws_instance.dev";

const DEFAULT_INSTANCE_TYPE = "m7i.2xlarge";
const DEFAULT_DISK_GB = 200;
const MIN_DISK_GB = 60;

export function cloudSettingsPath(name: string): string {
  return join(hostDir(name), "cloud.json");
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// Atomic write: temp file next to the target, then rename; 0600 like hosts.json.
function writePrivate(path: string, content: string): void {
  ensureDir(dirname(path));
  const tmp = `${path}.forge-tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600); // the umask may have narrowed the mode above
  renameSync(tmp, path);
}

const STR_FIELDS = ["awsProfile", "region", "instanceType", "alertEmail", "upstream", "fork", "botName", "botEmail"] as const;

function isSettings(v: unknown): v is CloudSettings {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return STR_FIELDS.every((k) => typeof o[k] === "string") &&
    Number.isInteger(o.diskGb) && Number.isInteger(o.budgetUsd) &&
    (o.sshCidr === undefined || typeof o.sshCidr === "string");
}

export function loadCloudSettings(name: string): CloudSettings {
  const path = cloudSettingsPath(name);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ForgeError(`${path}: missing; run forge install to answer the cloud questions`);
    }
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ForgeError(`${path}: not valid JSON (${(e as Error).message}); fix or remove the file`);
  }
  if (!isSettings(parsed)) throw new ForgeError(`${path}: not valid cloud settings; fix or remove the file`);
  return parsed;
}

export function saveCloudSettings(name: string, s: CloudSettings): void {
  writePrivate(cloudSettingsPath(name), JSON.stringify(s, null, 2) + "\n");
}

async function ask(ctx: Context, label: string, fallback?: string): Promise<string> {
  const answer = ((await ctx.prompt.ask(fallback ? `${label} [${fallback}]` : label)) ?? "").trim();
  return answer || fallback || "";
}

function checked(field: string, value: string, ok: (v: string) => boolean, expected: string): string {
  if (!ok(value)) throw new ForgeError(`${field}: "${value}" is not valid, expected ${expected}`);
  return value;
}

function positiveInt(field: string, value: string, min: number): number {
  checked(field, value, (v) => /^[0-9]+$/.test(v) && Number(v) >= min, `a whole number of at least ${min}`);
  return Number(value);
}

const validEmail = (v: string) => /^[^@\s]+@[^@\s]+$/.test(v);
const validRepo = (v: string) => /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(v);

export async function askCloudSettings(ctx: Context): Promise<CloudSettings> {
  const awsProfile = checked("AWS profile", await ask(ctx, "AWS profile (named profile of your AWS CLI)"),
    (v) => /^[A-Za-z0-9_.-]+$/.test(v), "letters, digits, . _ -");
  const region = checked("region", await ask(ctx, "AWS region (for example eu-west-3)"),
    (v) => /^[a-z]{2}(-[a-z]+)+-\d+$/.test(v), "an AWS region such as eu-west-3");
  const instanceType = checked("instance type", await ask(ctx, "Instance type", DEFAULT_INSTANCE_TYPE),
    (v) => /^[a-z0-9-]+\.[a-z0-9]+$/.test(v), "a type such as m7i.2xlarge");
  const diskGb = positiveInt("disk size", await ask(ctx, "Disk size in GB", String(DEFAULT_DISK_GB)), MIN_DISK_GB);
  const budgetUsd = positiveInt("budget", await ask(ctx, "Monthly budget alert in USD"), 1);
  const alertEmail = checked("alert email", await ask(ctx, "Email for budget and idle alerts"), validEmail, "an email address");
  const upstream = checked("upstream", await ask(ctx, "Upstream repository (owner/repo)"), validRepo, "owner/repo");
  const fork = checked("fork", await ask(ctx, "The agent's fork (owner/repo)"), validRepo, "owner/repo");
  const botName = checked("bot name", await ask(ctx, "Git author name of the agent"), (v) => v.length > 0, "a non-empty name");
  const botEmail = checked("bot email", await ask(ctx, "Git author email of the agent"), validEmail, "an email address");
  return { awsProfile, region, instanceType, diskGb, budgetUsd, alertEmail, upstream, fork, botName, botEmail };
}

export function infraFor(name: string, checkout: string): Infra {
  const settings = loadCloudSettings(name);
  const keyPath = forgeKeyPath(name);
  let adminKey: string;
  try {
    adminKey = readFileSync(keyPath, "utf8").trim();
  } catch {
    throw new ForgeError(`${keyPath}: missing; run forge install to choose the admin key`);
  }
  return { name, checkout, settings, adminKey };
}

export function renderTfvars(infra: Infra, running: boolean): string {
  const s = infra.settings;
  if (!s.sshCidr) throw new ForgeError("no SSH source address recorded yet; run forge cloud start to set it");
  return JSON.stringify({
    name: infra.name,
    region: s.region,
    aws_profile: s.awsProfile,
    admin_public_key: infra.adminKey,
    ssh_cidr: s.sshCidr,
    running,
    instance_type: s.instanceType,
    disk_gb: s.diskGb,
    budget_usd: s.budgetUsd,
    alert_email: s.alertEmail,
  }, null, 2) + "\n";
}

// The address OpenTofu opens SSH to. A captive portal or proxy answers with
// HTML: anything but one IPv4 address must never reach a security group rule.
export async function currentPublicIp(ctx: Context): Promise<string> {
  const r = await ctx.exec(["curl", "-fsS", "--max-time", "10", "https://checkip.amazonaws.com"]);
  const text = r.stdout.trim();
  if (r.code !== 0 || parseAddress(text) === null) {
    throw new ForgeError(`could not read this machine's public address (${r.stderr.trim() || text.slice(0, 80) || `exit code ${r.code}`})`);
  }
  return text;
}

export async function checkNestedVirt(ctx: Context, s: CloudSettings): Promise<void> {
  const r = await ctx.exec([
    "aws", "ec2", "describe-instance-types", "--profile", s.awsProfile, "--region", s.region,
    "--instance-types", s.instanceType, "--query", "InstanceTypes[0].ProcessorInfo.SupportedFeatures", "--output", "json",
  ]);
  if (r.code !== 0) throw new ForgeError(`aws describe-instance-types failed: ${r.stderr.trim() || `exit code ${r.code}`}`);
  let features: unknown;
  try {
    features = JSON.parse(r.stdout);
  } catch {
    features = null;
  }
  if (!Array.isArray(features) || !features.includes("nested-virtualization")) {
    throw new ForgeError(`${s.instanceType} in ${s.region} does not support nested virtualization, which Incus VMs need; choose another instance type or region`);
  }
}

function tofuArgs(infra: Infra, ...args: string[]): string[] {
  return ["tofu", `-chdir=${infra.checkout}/infra/aws`, ...args];
}

function tofuEnv(infra: Infra): { TF_DATA_DIR: string } {
  return { TF_DATA_DIR: join(hostDir(infra.name), "tofu") };
}

// Writes the variables and initializes the backend; returns the tfvars path.
async function prepare(ctx: Context, infra: Infra, running: boolean): Promise<string> {
  const dir = hostDir(infra.name);
  const tfvars = join(dir, "tofu.tfvars.json");
  writePrivate(tfvars, renderTfvars(infra, running));
  await mustSucceed("tofu init", ctx.exec(
    tofuArgs(infra, "init", "-input=false", `-backend-config=path=${join(dir, "terraform.tfstate")}`),
    { env: tofuEnv(infra) },
  ));
  return tfvars;
}

// OpenTofu shows its plan and asks for `yes` itself.
export async function applyInteractive(ctx: Context, infra: Infra, extra: string[] = []): Promise<void> {
  const tfvars = await prepare(ctx, infra, true);
  const code = await ctx.attach(tofuArgs(infra, "apply", `-var-file=${tfvars}`, ...extra), { env: tofuEnv(infra) });
  if (code !== 0) throw new ForgeError(`tofu apply failed (exit code ${code})`);
}

type PlanChange = { address: string; change: { actions: string[] } };

// Start and stop run without review, so they apply only a plan that changes
// things in place (the instance state, the SSH rule): a plan that would create
// or destroy anything, such as a replaced VM after a git pull of infra/aws,
// is refused and left to `forge cloud create`.
export async function applyQuiet(ctx: Context, infra: Infra, running: boolean): Promise<void> {
  const tfvars = await prepare(ctx, infra, running);
  const plan = join(hostDir(infra.name), "start.tfplan");
  const env = tofuEnv(infra);
  await mustSucceed("tofu plan", ctx.exec(tofuArgs(infra, "plan", "-input=false", `-var-file=${tfvars}`, `-out=${plan}`), { env }));
  const shown = await mustSucceed("tofu show", ctx.exec(tofuArgs(infra, "show", "-json", plan), { env }));
  let changes: PlanChange[];
  try {
    changes = (JSON.parse(shown.stdout).resource_changes ?? []) as PlanChange[];
  } catch {
    throw new ForgeError("tofu show: the plan is not readable JSON");
  }
  const SAFE = ["no-op", "update", "read"];
  const unsafe = changes.filter((c) => c.change.actions.some((a) => !SAFE.includes(a)));
  if (unsafe.length > 0) {
    const verbs = [...new Set(unsafe.flatMap((c) => c.change.actions.filter((a) => !SAFE.includes(a))))].join("/");
    throw new ForgeError(
      `this checkout's infra/aws would also ${verbs} ${unsafe.map((c) => c.address).join(", ")}: ` +
      `forge cloud start and stop only start, stop and open SSH. Run forge cloud create --host ${infra.name} to review and apply it.`,
    );
  }
  await mustSucceed("tofu apply", ctx.exec(tofuArgs(infra, "apply", "-input=false", plan), { env }));
}

export async function infraAddress(ctx: Context, infra: Infra): Promise<string> {
  const r = await mustSucceed("tofu output", ctx.exec(tofuArgs(infra, "output", "-raw", "address"), { env: tofuEnv(infra) }));
  const address = r.stdout.trim();
  if (parseAddress(address) === null) throw new ForgeError(`tofu output address: "${address.slice(0, 80)}" is not an IPv4 address`);
  return address;
}
