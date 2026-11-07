import { test } from "node:test";
import assert from "node:assert/strict";
import { remoteAttach, remoteExec } from "../cli/lib/laptop/remote.ts";
import type { LaptopHost } from "../cli/lib/laptop/state.ts";
import { fakeContext } from "./lib/fake-context.ts";

const host: LaptopHost = {
  name: "forge-acme", kind: "remote", address: "203.0.113.10", port: 22, user: "forge",
  admin: "ubuntu", adminKey: "/keys/admin", exposure: "public", done: [],
};

test("remoteExec sends each argument to ssh as one quoted word", async () => {
  const ctx = fakeContext({ rules: [{ match: "ssh", stdout: "ok\n" }] });
  const r = await remoteExec(ctx, host, ["git", "config", "--global", "user.name", "Al O'Neil Jr"]);
  assert.equal(r.stdout, "ok\n");
  assert.deepEqual(ctx.calls[0], [
    "ssh", "-o", "BatchMode=yes", "-o", "ForwardAgent=no", "forge-acme", "--",
    `'git' 'config' '--global' 'user.name' 'Al O'\\''Neil Jr'`,
  ]);
});

test("remoteExec returns a non-zero exit code instead of throwing", async () => {
  const ctx = fakeContext({ rules: [{ match: "ssh", code: 1 }] });
  assert.equal((await remoteExec(ctx, host, ["test", "-e", "x"])).code, 1);
});

test("remoteAttach asks for a tty only when told to", async () => {
  const ctx = fakeContext({ attachCode: 3 });
  assert.equal(await remoteAttach(ctx, host, ["forge", "setup"]), 3);
  assert.deepEqual(ctx.attachCalls[0].argv, ["ssh", "-o", "ForwardAgent=no", "forge-acme", "--", "'forge' 'setup'"]);
  await remoteAttach(ctx, host, ["claude", "auth", "login"], true);
  assert.deepEqual(ctx.attachCalls[1].argv, ["ssh", "-o", "ForwardAgent=no", "-t", "forge-acme", "--", "'claude' 'auth' 'login'"]);
});

test("remoteExec feeds input on stdin, never in argv", async () => {
  const ctx = fakeContext({ rules: [{ match: "ssh" }] });
  await remoteExec(ctx, host, ["cat"], "secret\n");
  assert.deepEqual(ctx.execOptions[0], { input: "secret\n" });
  assert.ok(!ctx.calls[0].some((a) => a.includes("secret")));
  await remoteExec(ctx, host, ["cat"]);
  assert.equal(ctx.execOptions[1], undefined);
});
