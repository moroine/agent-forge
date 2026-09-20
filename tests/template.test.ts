// tests/template.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import { cmdTemplate } from "../scripts/lib/commands/template.ts";
import { writeToken } from "../scripts/lib/credentials.ts";

const REPO = "o/r";
const TEMPLATE_NAME = "agent-o-r";

// Même host sandboxé que tests/provision.test.ts : provisionTemplate a besoin
// de ces deux fichiers pour dépasser ses premiers existsSync, et de chemins
// hôte qui ne touchent jamais le vrai home du container.
function sandboxHost(): void {
  const home = mkdtempSync(join(tmpdir(), "forge-tpl-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
  writeFileSync(join(home, ".ssh", "github_agents_signing"), "key");
  process.env.FORGE_HOME = home;
  process.env.FORGE_REPO_DIR = process.cwd();
  process.env.FORGE_WORKSPACES = join(home, "workspaces");
}

// Même sandbox que tests/credentials.test.ts et tests/token.test.ts : un
// répertoire FORGE_CONFIG_HOME neuf, dans lequel un token est déjà stocké,
// pour que readToken le trouve sans jamais passer par askSecret.
function sandboxWithToken(ownerRepo: string, token: string): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-tpl-cred-"));
  process.env.FORGE_CONFIG_HOME = dir;
  writeToken(ownerRepo, token);
  return dir;
}

type FleetOpts = {
  template: string | null;
  tasks: Record<string, string>;
  answers?: (number | string | null)[];
};

// Même construction que fleetCtx dans tests/containers.test.ts : un unique
// `lxc list`, puis les clés de config par container — plus le host sandboxé
// dont provisionTemplate a besoin pour aller jusqu'au bout.
function fleetCtx(opts: FleetOpts) {
  sandboxHost();
  const meta: Record<string, Record<string, string>> = {};
  const instances: { name: string; status: string }[] = [];
  if (opts.template !== null) {
    instances.push({ name: TEMPLATE_NAME, status: opts.template });
    meta[TEMPLATE_NAME] = { repo: REPO, mode: "autonomous", role: "template", task: "" };
  }
  for (const [task, status] of Object.entries(opts.tasks)) {
    const name = `${TEMPLATE_NAME}-${task}`;
    instances.push({ name, status });
    meta[name] = { repo: REPO, mode: "autonomous", role: "task", task };
  }
  return fakeContext({
    rules: [
      { match: "lxc list", stdout: JSON.stringify(instances) },
      { match: "image info", code: 0 },
      ...Object.entries(meta).flatMap(([name, m]) => [
        { match: `config get ${name} user.forge.repo`, stdout: m.repo },
        { match: `config get ${name} user.forge.mode`, stdout: m.mode },
        { match: `config get ${name} user.forge.role`, stdout: m.role },
        { match: `config get ${name} user.forge.task`, stdout: m.task },
      ]),
    ],
    answers: opts.answers ?? [],
  });
}

test("template rebuild deletes the old template and provisions a new one", async () => {
  const ctx = fleetCtx({ template: "Stopped", tasks: {}, answers: ["a"] });
  process.env.FORGE_CONFIG_HOME = sandboxWithToken("o/r", "ghp_x");
  assert.equal(await cmdTemplate(ctx, "rebuild", "o/r"), 0);
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(joined.includes("lxc delete agent-o-r --force"));
  assert.ok(joined.some((s) => s.startsWith("lxc launch")));
  assert.ok(joined.indexOf("lxc delete agent-o-r --force") < joined.findIndex((s) => s.startsWith("lxc launch")));
});

test("template rebuild never prompts for a token when the store has one", async () => {
  const ctx = fleetCtx({ template: "Stopped", tasks: {}, answers: ["a"] });
  process.env.FORGE_CONFIG_HOME = sandboxWithToken("o/r", "ghp_x");
  await cmdTemplate(ctx, "rebuild", "o/r");
  assert.ok(!ctx.err_lines.some((l) => l.includes("Paste the token")));
});

test("template rebuild leaves existing task containers alone", async () => {
  const ctx = fleetCtx({ template: "Stopped", tasks: { cli: "Running" }, answers: ["a"] });
  process.env.FORGE_CONFIG_HOME = sandboxWithToken("o/r", "ghp_x");
  await cmdTemplate(ctx, "rebuild", "o/r");
  const joined = ctx.calls.map((c) => c.join(" "));
  assert.ok(!joined.includes("lxc delete agent-o-r-cli --force"));
  assert.match(ctx.err_lines.join("\n"), /existing task/i);
});

test("template rebuild on a repo with no template is a ForgeError", async () => {
  const ctx = fleetCtx({ template: null, tasks: {} });
  await assert.rejects(() => cmdTemplate(ctx, "rebuild", "o/r"), /no template/);
});

test("an unknown subcommand yields the usage", async () => {
  await assert.rejects(() => cmdTemplate(fleetCtx({ template: "Stopped", tasks: {} }), "bogus", "o/r"),
    /Usage: forge template/);
});
