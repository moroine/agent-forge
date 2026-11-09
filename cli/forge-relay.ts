// The relay's entry point, run on the relay VM: `serve` is the SSH forced
// command of the dev VM's key, `setup` is the maintainer's check.
import { readFileSync } from "node:fs";
import { createContext } from "./lib/context.ts";
import { loadRelayConfig, RelayError } from "./lib/relay/config.ts";
import { githubClient } from "./lib/relay/github.ts";
import { RELAY_PATHS } from "./lib/relay/paths.ts";
import type { RelayDeps } from "./lib/relay/publish.ts";
import { serve } from "./lib/relay/serve.ts";
import { relaySetup } from "./lib/relay/setup.ts";

const MAX_INPUT = 64 * 1024 * 1024;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

// stdin up to the cap, or null when the request is larger.
async function readInput(): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of process.stdin as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > MAX_INPUT) return null;
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const token = () => readFileSync(RELAY_PATHS.token, "utf8").trim();

async function main(): Promise<number> {
  const ctx = createContext();
  if (process.getuid?.() === 0) {
    ctx.err("forge-relay: refusing to run as root");
    return 1;
  }
  const cmd = process.argv[2];
  try {
    const cfg = loadRelayConfig(RELAY_PATHS.config);
    const github = githubClient(token());
    if (cmd === "setup") {
      const pub = readFileSync(`${RELAY_PATHS.signingKey}.pub`, "utf8");
      return await relaySetup(ctx, github, cfg, pub, sleep);
    }
    if (cmd === "serve") {
      const input = await readInput();
      if (input === null) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: "the request is larger than 64 MiB" })}\n`);
        return 1;
      }
      const d: RelayDeps = { ctx, cfg, paths: RELAY_PATHS, github, sleep, now: () => Date.now() };
      const line = await serve(d, process.env.SSH_ORIGINAL_COMMAND?.trim(), input);
      process.stdout.write(line);
      return line.startsWith('{"ok":true') ? 0 : 1;
    }
    ctx.err("Usage: forge-relay serve | setup");
    return 1;
  } catch (e) {
    if (cmd === "serve") {
      // The forced command's client reads one JSON line, whatever went wrong.
      const refused = e instanceof RelayError;
      if (!refused) ctx.err(`forge-relay: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      process.stdout.write(`${JSON.stringify({ ok: false, error: refused ? e.message : "internal error (logged on the relay)" })}\n`);
    } else {
      ctx.err(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    return 1;
  }
}

process.exit(await main());
