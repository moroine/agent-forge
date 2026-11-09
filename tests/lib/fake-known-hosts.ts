// forge's known_hosts as ssh and ssh-keygen keep it, in the test's temporary
// home: an attached first connection (`ssh … <admin>@<address> true`, without
// BatchMode) records the address's ed25519 key, `ssh-keygen -F` finds it the
// way the real one prints it, and `ssh-keygen -R` forgets it. Calls are logged
// like any other.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FakeContext } from "./fake-context.ts";

// A distinct, stable key per address.
export const hostKeyOf = (address: string): string =>
  `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${Buffer.from(address).toString("base64").replace(/=+$/, "")}`;

export function withKnownHosts(ctx: FakeContext, file: () => string): FakeContext {
  const { exec, attach } = ctx;
  const lines = (): string[] => (existsSync(file()) ? readFileSync(file(), "utf8").split("\n").filter((l) => l !== "") : []);
  ctx.exec = async (argv, opts) => {
    if (argv[0] !== "ssh-keygen" || !["-F", "-R"].includes(argv[1]) || argv[3] !== "-f" || argv[4] !== file()) {
      return exec(argv, opts);
    }
    ctx.calls.push(argv);
    ctx.execOptions.push(opts);
    const all = lines();
    const mine = (l: string) => l.split(" ")[0] === argv[2];
    if (argv[1] === "-R") {
      writeFileSync(file(), all.filter((l) => !mine(l)).map((l) => `${l}\n`).join(""));
      return { code: 0, stdout: "", stderr: "" };
    }
    const found = all.map((l, i) => [l, i + 1] as const).filter(([l]) => mine(l));
    if (found.length === 0) return { code: 1, stdout: "", stderr: "" };
    return { code: 0, stdout: found.map(([l, n]) => `# Host ${argv[2]} found: line ${n}\n${l}\n`).join(""), stderr: "" };
  };
  ctx.attach = async (argv, opts) => {
    const code = await attach(argv, opts);
    if (code === 0 && argv[0] === "ssh" && argv.at(-1) === "true" && !argv.includes("BatchMode=yes")) {
      const address = argv.at(-2)!.split("@")[1];
      if (!lines().some((l) => l.split(" ")[0] === address)) {
        mkdirSync(dirname(file()), { recursive: true });
        appendFileSync(file(), `${address} ${hostKeyOf(address)}\n`);
      }
    }
    return code;
  };
  return ctx;
}
