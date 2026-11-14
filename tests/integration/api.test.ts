// Layer 3 for the API between containers (DX 5, part 2): two throwaway
// containers on a real Incus, opt-in, on a disposable Incus.
//
//   FORGE_INTEGRATION=1 node --test tests/integration/api.test.ts
//
// What the unit tests' fake `incus` and `hc` cannot show: the options of the
// `proxy` device, the messages and the shape of `hc send`, the socket that
// comes back after `incus restart`. `serveApi` runs in this process, with a
// session that announces its own status: no Claude token is needed.
import { test, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../../cli/lib/api/journal.ts";
import { ensureApiAccess } from "../../cli/lib/api/access.ts";
import { hostSocketPath, serveApi } from "../../cli/lib/api/server.ts";
import { parseConfig } from "../../cli/lib/config.ts";
import { createContext } from "../../cli/lib/context.ts";
import { deliverMessage, hcArgv, MESSAGES_DIR } from "../../cli/lib/hc-session.ts";
import { memberNamed } from "../../cli/lib/team.ts";
import { ENABLED, PREFIX, incus, launch, must, raw, run, waitReady, type Run } from "./lib.ts";

const PROJECT = "agent-forge";
// `agent-forge-selftest-…`: the name prefix the teardown guard recognises.
const TEAM = "forge-selftest";
const LEAD = `agent-${TEAM}-lead`;
const DEV = `agent-${TEAM}-dev-1`;
const NAMES = [LEAD, DEV];
const saved = { project: process.env.FORGE_INCUS_PROJECT, runtime: process.env.FORGE_API_RUNTIME };
const root = ENABLED ? mkdtempSync(join(tmpdir(), "forge-selftest-api-")) : "";
const stop = new AbortController();
let served: Promise<void> | null = null;

if (ENABLED) {
  process.env.FORGE_INCUS_PROJECT = PROJECT;
  process.env.FORGE_API_RUNTIME = join(root, "run");
}

after(async () => {
  if (!ENABLED) return;
  stop.abort();
  await served;
  for (const name of NAMES) {
    if (name.startsWith(PREFIX)) incus(PROJECT, ["delete", name, "--force"]);
  }
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of [["FORGE_INCUS_PROJECT", saved.project], ["FORGE_API_RUNTIME", saved.runtime]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const hasImage = () => ENABLED && incus(PROJECT, ["image", "info", "agent-base"]).status === 0;
// The API runs in this process: a call that waits for it must not block the
// event loop (lib.ts's `run` is spawnSync), or the server never answers.
function runAsync(cmd: string, args: string[], input = ""): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}
const asAiuser = (name: string, argv: string[], input = "") =>
  runAsync("incus", ["--project", PROJECT, "exec", name, "--user", "1001", "--group", "1001", "--env", "HOME=/home/aiuser", "--", ...argv], input);
const hc = (name: string, args: string[]) => {
  const argv = hcArgv(name, args);
  return run("incus", argv.slice(1));
};

test("the API over a real proxy device: identity by socket, a message as a file and a notice, a restart", { skip: !ENABLED }, async (t: TestContext) => {
  if (!hasImage()) return t.skip(`no agent-base in project ${PROJECT} (run 'forge image build')`);

  const cfg = parseConfig("/c.json", {
    teams: {
      [TEAM]: {
        repo: "forge-selftest/throwaway",
        roles: {
          lead: { capabilities: ["repo", "assign"], talkTo: ["team"] },
          dev: { count: 1, capabilities: ["repo", "publish"], talkTo: ["lead"] },
        },
      },
    },
  });
  const ctx = createContext();
  for (const name of NAMES) {
    launch(PROJECT, name);
    await ensureApiAccess(ctx, memberNamed(cfg, name));
  }
  served = serveApi({
    ctx, cfg, journal: Journal.open(join(root, "journal.jsonl")), secrets: [], now: () => new Date(),
  }, stop.signal);
  for (let i = 0; i < 100 && !NAMES.every((n) => existsSync(hostSocketPath(n))); i++) await new Promise((r) => setTimeout(r, 50));

  // The API knows the caller by the socket: each container is answered as itself.
  const leadStatus = must("forge-team status in the lead", await asAiuser(LEAD, ["forge-team", "status"]));
  assert.match(leadStatus.stdout, new RegExp(`^${DEV} role=dev`, "m"), raw("the lead's status", leadStatus));
  const devStatus = must("forge-team status in the developer", await asAiuser(DEV, ["forge-team", "status"]));
  assert.match(devStatus.stdout, new RegExp(`^${LEAD} role=lead`, "m"), raw("the developer's status", devStatus));
  assert.doesNotMatch(devStatus.stdout, new RegExp(`^${DEV} `, "m"));

  // A container holds its own socket only: nothing of the other's host socket is in it.
  assert.equal(incus(PROJECT, ["exec", DEV, "--", "test", "-e", hostSocketPath(LEAD)]).status, 1,
    "the lead's host socket path exists in the developer's container");
  assert.equal(must("socket in the developer", incus(PROJECT, ["exec", DEV, "--", "stat", "-c", "%U %a", "/var/lib/forge/api.sock"])).stdout.trim(),
    "aiuser 600");

  // A session that announces itself idle (OSC 7501), then echoes what it is typed.
  must("a fake session in the lead", hc(LEAD, ["run", "--bg", "--name", "agent", "--cwd", "/workspace",
    "sh", "-c", "printf '\\033]7501;state=idle:app=fake\\033\\\\'; cat"]));
  const body = "Détail : Esc \u001b, fin de collage \u001b[201~\n";
  const sent = must("forge-team message", await asAiuser(DEV, ["forge-team", "message", LEAD, "Fini, branche agent/x"], body));
  const id = /^ok (\d+)$/m.exec(sent.stdout)?.[1];
  assert.ok(id, raw("the message's id", sent));
  const path = `${MESSAGES_DIR}/${id}.md`;
  // The body is a file, byte for byte; the session only got the notice.
  assert.equal(must("read the message file", incus(PROJECT, ["file", "pull", `${LEAD}${path}`, "-"])).stdout, body);
  const screen = must("hc read", hc(LEAD, ["read", "agent"])).stdout;
  assert.ok(screen.includes(`[forge] message ${id} from ${DEV}: Fini, branche agent/x (detail: ${path})`), raw("the lead's screen", { status: 0, stdout: screen, stderr: "" }));
  assert.ok(!screen.includes("201~"), "a byte of the body reached the terminal");

  // hc's own words for a session that has ended: deliverMessage reads them as "no live session".
  must("kill the session", hc(LEAD, ["kill", "agent"]));
  await assert.rejects(deliverMessage(ctx, LEAD, DEV, 99, "Fini", null), new RegExp(`${LEAD} has no live session`));

  // The socket comes back with the container.
  must("incus restart", incus(PROJECT, ["restart", LEAD]));
  waitReady(PROJECT, LEAD);
  const again = must("forge-team status after the restart", await asAiuser(LEAD, ["forge-team", "status"]));
  assert.match(again.stdout, new RegExp(`^${DEV} role=dev`, "m"));
});
