import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { cmdImage } from "../cli/lib/commands/image.ts";

test("forge image build passes only the sub to the bash script", async () => {
  const ctx = fakeContext();
  await cmdImage(ctx, "build");
  const call = ctx.calls[0];
  assert.equal(call[0], "bash");
  assert.equal(call.at(-1), "build");
});

test("forge image build super passes build + super to the bash script", async () => {
  const ctx = fakeContext();
  await cmdImage(ctx, "build", "super");
  const call = ctx.calls[0];
  assert.equal(call.at(-2), "build");
  assert.equal(call.at(-1), "super");
});

test("forge image build with an unknown target is rejected", async () => {
  await assert.rejects(() => cmdImage(fakeContext(), "build", "nope"), /Usage: forge image/);
});

test("forge image with an unknown sub is rejected", async () => {
  await assert.rejects(() => cmdImage(fakeContext(), "bogus"), /Usage: forge image/);
});
