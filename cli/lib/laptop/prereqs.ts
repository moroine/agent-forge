// Vérifie, avant `forge install`, que les outils de la machine de dev sont là.
// Ne cherche pas l'agent SSH (voir keys.ts) et n'installe rien : il dit quoi
// installer et laisse l'utilisateur le faire.
import { ForgeError, type Context } from "../context.ts";

const LIMA_FLOOR = "2.1.2";
const ANSIBLE_FLOOR = "2.20";
const TOFU_FLOOR = "1.10.0";

type Tool = "lima" | "ansible" | "herdr" | "git" | "ssh" | "tofu" | "aws";
type Problem = { tool: Tool; text: string };

// Comparaison numérique composante par composante (2.10.0 > 2.9.9).
function atLeast(found: string, floor: string): boolean {
  const a = found.split(".").map(Number);
  const b = floor.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export async function checkPrerequisites(
  ctx: Context,
  kind: "lima" | "remote" | "cloud",
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const problems: Problem[] = [];
  // Un binaire absent sort en 127 ; `ssh -V` écrit sa version sur stderr.
  const run = async (argv: string[]) => {
    const r = await ctx.exec(argv);
    return { ok: r.code === 0, text: `${r.stdout}\n${r.stderr}` };
  };
  const versioned = async (tool: Tool, argv: string[], re: RegExp, floor: string, label: string) => {
    const r = await run(argv);
    if (!r.ok) { problems.push({ tool, text: `${label} is not installed (needs ${floor} or newer)` }); return; }
    const v = re.exec(r.text)?.[1];
    if (!v) { problems.push({ tool, text: `${label}: could not read its version (needs ${floor} or newer)` }); return; }
    if (!atLeast(v, floor)) problems.push({ tool, text: `${label} ${v} is too old (needs ${floor} or newer)` });
  };
  const present = async (tool: Tool, argv: string[], label: string) => {
    if (!(await run(argv)).ok) problems.push({ tool, text: `${label} is not installed` });
  };

  if (kind === "lima") await versioned("lima", ["limactl", "--version"], /limactl version (\d+(?:\.\d+)*)/, LIMA_FLOOR, "limactl");
  if (kind === "cloud") {
    await versioned("tofu", ["tofu", "version"], /OpenTofu v(\d+(?:\.\d+)*)/, TOFU_FLOOR, "OpenTofu (tofu)");
    await versioned("aws", ["aws", "--version"], /aws-cli\/(\d+(?:\.\d+)*)/, "2", "AWS CLI v2 (aws)");
  }
  await versioned("ansible", ["ansible-playbook", "--version"], /\[core (\d+(?:\.\d+)*)/, ANSIBLE_FLOOR, "ansible-playbook (ansible-core)");
  await present("ansible", ["ansible-galaxy", "--version"], "ansible-galaxy");
  await present("herdr", ["herdr", "--version"], "herdr");
  await present("git", ["git", "--version"], "git");
  await present("ssh", ["ssh", "-V"], "ssh");

  if (problems.length === 0) return;

  const missing = new Set(problems.map((p) => p.tool));
  const lines = ["Prerequisites are missing:", ...problems.map((p) => `  - ${p.text}`)];
  const install: string[] = [];
  if (platform === "darwin") {
    const brew = (["lima", "ansible", "herdr"] as const).filter((t) => missing.has(t));
    const formulae = [...brew.map(String), ...(missing.has("tofu") ? ["opentofu"] : []), ...(missing.has("aws") ? ["awscli"] : [])];
    if (formulae.length) install.push(`brew install ${formulae.join(" ")}`);
  } else {
    if (missing.has("lima")) {
      install.push(
        `Lima ${LIMA_FLOOR} or newer, from its release archive: https://github.com/lima-vm/lima/releases`,
        "  (needs qemu-system-x86 and qemu-utils, and your user in the kvm group)",
      );
    }
    if (missing.has("ansible")) install.push(`pipx install ansible-core   # ${ANSIBLE_FLOOR} or newer`);
    if (missing.has("herdr")) install.push("herdr: install it from its releases, https://herdr.dev");
    if (missing.has("tofu")) install.push(`OpenTofu ${TOFU_FLOOR} or newer: https://opentofu.org/docs/intro/install/`);
    if (missing.has("aws")) install.push("AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html");
  }
  if (missing.has("git")) install.push("install git with your package manager");
  if (missing.has("ssh")) install.push("install an OpenSSH client with your package manager");
  if (install.length) lines.push("", "To install:", ...install.map((l) => `  ${l}`));
  throw new ForgeError(lines.join("\n"));
}
