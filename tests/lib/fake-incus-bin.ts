// `incus` on the PATH of tests/e2e.test.ts. Each call is a new process, so the
// state is rebuilt from the same seed every time: enough for the read-only
// commands the end-to-end tests run.
import { readFileSync } from "node:fs";
import { FakeIncus } from "./fake-incus.ts";

const fake = FakeIncus.withRuntime();
fake.addInstance("agent-forge", "agent-moroine-agent-forge", {
  status: "Running",
  config: { "user.forge.repo": "moroine/agent-forge", "user.forge.mode": "supervised" },
});
fake.addInstance("agent-forge", "agent-acme-widgets", {
  status: "Stopped",
  config: { "user.forge.repo": "acme/widgets", "user.forge.mode": "supervised" },
});

const argv = process.argv.slice(2);
// Only create and edit read stdin; reading it otherwise could block.
const input = argv.includes("create") || argv.includes("edit") ? readFileSync(0, "utf8") : undefined;
const r = fake.run(argv, input);
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
process.exit(r.code);
