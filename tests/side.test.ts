import { test } from "node:test";
import assert from "node:assert/strict";
import { LAPTOP_COMMANDS, commandSide, currentSide, requireSide } from "../cli/lib/side.ts";
import { ForgeError } from "../cli/lib/context.ts";

test("FORGE_SIDE wins over the filesystem", () => {
  assert.equal(currentSide({ FORGE_SIDE: "laptop" }, () => true), "laptop");
  assert.equal(currentSide({ FORGE_SIDE: "host" }, () => false), "host");
});

test("an invalid FORGE_SIDE is ignored", () => {
  assert.equal(currentSide({ FORGE_SIDE: "nope" }, () => true), "host");
});

test("/opt/agent-forge present means host, absent means laptop", () => {
  const seen: string[] = [];
  assert.equal(currentSide({}, (p) => { seen.push(String(p)); return true; }), "host");
  assert.deepEqual(seen, ["/opt/agent-forge"]);
  assert.equal(currentSide({}, () => false), "laptop");
});

test("commandSide: laptop commands, host commands, completion", () => {
  for (const c of LAPTOP_COMMANDS) assert.equal(commandSide(c), "laptop");
  assert.equal(commandSide("cloud"), "laptop");
  assert.equal(commandSide("list"), "host");
  assert.equal(commandSide("start"), "host");
  const here = currentSide();
  assert.equal(commandSide("completion"), here);
});

test("forge start on the laptop names the herdr way in", () => {
  assert.throws(() => requireSide("start", "laptop"), (e: unknown) =>
    e instanceof ForgeError &&
    e.message === "forge start runs on the forge host: in herdr (forge open), press prefix+f.");
});

test("another host command on the laptop names ssh", () => {
  assert.throws(() => requireSide("list", "laptop"), (e: unknown) =>
    e instanceof ForgeError &&
    e.message === "forge list runs on the forge host: ssh <host> forge list, or from herdr.");
});

test("the host commands that forge fetch and ship call over SSH say where they run", () => {
  for (const cmd of ["upload-pack", "task-base"]) {
    assert.throws(() => requireSide(cmd, "laptop"), (e: unknown) =>
      e instanceof ForgeError &&
      e.message === `forge ${cmd} runs on the forge host: ssh <host> forge ${cmd}, or from herdr.`);
    requireSide(cmd, "host");
  }
});

test("a laptop command on the host says it runs on the laptop", () => {
  assert.throws(() => requireSide("install", "host"), (e: unknown) =>
    e instanceof ForgeError &&
    e.message === "forge install runs on your laptop, in the agent-forge checkout.");
});

test("matching sides, completion and unknown commands pass", () => {
  requireSide("list", "host");
  requireSide("install", "laptop");
  requireSide("completion", "host");
  requireSide("completion", "laptop");
  requireSide("bogus", "laptop");
  requireSide("bogus", "host");
});
