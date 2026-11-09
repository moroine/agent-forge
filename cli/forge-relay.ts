// The relay's entry point, run on the relay VM: `serve` is the SSH forced
// command of the dev VM's key, `setup` is the maintainer's check.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext } from "./lib/context.ts";
import { loadRelayConfig } from "./lib/relay/config.ts";
import { githubClient } from "./lib/relay/github.ts";
import { RELAY_PATHS, readToken, type RelayPaths } from "./lib/relay/paths.ts";
import type { RelayDeps } from "./lib/relay/publish.ts";
import { auditFor, fail, serve } from "./lib/relay/serve.ts";
import { RelayError } from "./lib/relay/config.ts";
import { MAX_REQUEST_BYTES as MAX_INPUT } from "./lib/relay/policy.ts";
import { relaySetup } from "./lib/relay/setup.ts";

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export type MainIo = {
  args: string[];
  env: Record<string, string | undefined>;
  stdin: AsyncIterable<Buffer>;
  // Resolves once the text is flushed: an exit must never cut an answer short.
  stdout: (text: string) => Promise<void>;
  stderr: (line: string) => void;
  uid: number;
  paths: RelayPaths;
  // Replaces what is built from the configuration and the token files.
  deps?: RelayDeps;
};

// stdin up to the cap, or null as soon as it is exceeded: the rest is not read.
async function readInput(stdin: AsyncIterable<Buffer>): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of stdin) {
    size += c.length;
    if (size > MAX_INPUT) return null;
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// Never a stack on stderr in serve mode: an SSH forced command sends stderr
// back to the dev VM. The stack is in the audit log.
function buildDeps(io: MainIo): RelayDeps {
  if (io.deps !== undefined) return io.deps;
  const ctx = { ...createContext(), err: io.stderr };
  return { ctx, cfg: loadRelayConfig(io.paths.config), paths: io.paths, github: githubClient(readToken(io.paths.token)), sleep, now: () => Date.now() };
}

export async function main(io: MainIo): Promise<number> {
  if (io.uid === 0) {
    io.stderr("forge-relay: refusing to run as root");
    return 1;
  }
  const cmd = io.args[0];
  if (cmd !== "serve" && cmd !== "setup") {
    io.stderr("Usage: forge-relay serve | setup");
    return 1;
  }
  if (cmd === "setup") {
    try {
      const d = buildDeps(io);
      const pub = readFileSync(`${io.paths.signingKey}.pub`, "utf8");
      return await relaySetup(d.ctx, d.github, d.cfg, pub, sleep);
    } catch (e) {
      io.stderr(`Error: ${e instanceof RelayError ? e.message : e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }

  // serve: whatever goes wrong, the client reads one JSON line, and the audit
  // log gets one line.
  const op = io.env.SSH_ORIGINAL_COMMAND?.trim();
  const sink = { paths: io.paths, err: io.stderr, now: () => Date.now() };
  const input = await readInput(io.stdin);
  if (input === null) {
    await io.stdout(await fail(sink, auditFor(sink, op), new RelayError("the request is larger than 64 MiB")));
    return 1;
  }
  let d: RelayDeps;
  try {
    d = buildDeps(io);
  } catch (e) {
    if (!(e instanceof RelayError)) io.stderr("forge-relay: internal error (see the audit log)");
    await io.stdout(await fail(sink, auditFor(sink, op), e));
    return 1;
  }
  const line = await serve(d, op, input);
  await io.stdout(line);
  return line.startsWith('{"ok":true') ? 0 : 1;
}

// Run only as the program, not when a test imports main.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const code = await main({
    args: process.argv.slice(2),
    env: process.env,
    stdin: process.stdin as AsyncIterable<Buffer>,
    stdout: (text) => new Promise<void>((done) => process.stdout.write(text, () => done())),
    stderr: (line) => process.stderr.write(`${line}\n`),
    uid: process.getuid?.() ?? -1,
    paths: RELAY_PATHS,
  });
  process.exit(code);
}
