// Faux `lxc` pour les tests bout-en-bout. Liste déterministe intégrée : pas de
// lecture de tests/fixtures/ ici (voir Task 17, mode --capture) — cette
// fixture-là vient d'un vrai LXD dont les noms de containers dépendent de la
// machine, et la rejouer casserait les assertions e2e qui vérifient des noms
// de repo précis.
const DEFAULT_LIST = [
  { name: "agent-moroine-agent-forge", status: "Stopped" },
  { name: "agent-moroine-agent-forge-cli", status: "Running" },
  { name: "agent-acme-widgets", status: "Stopped" },
];

const REPOS: Record<string, string> = {
  "agent-moroine-agent-forge": "moroine/agent-forge",
  "agent-moroine-agent-forge-cli": "moroine/agent-forge",
  "agent-acme-widgets": "acme/widgets",
};
const MODES: Record<string, string> = {
  "agent-moroine-agent-forge": "autonomous",
  "agent-moroine-agent-forge-cli": "autonomous",
  "agent-acme-widgets": "supervised",
};
const ROLES: Record<string, string> = {
  "agent-moroine-agent-forge": "template",
  "agent-moroine-agent-forge-cli": "task",
  "agent-acme-widgets": "template",
};
const TASKS: Record<string, string> = { "agent-moroine-agent-forge-cli": "cli" };

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;

if (cmd === "list") {
  process.stdout.write(JSON.stringify(DEFAULT_LIST));
  process.exit(0);
}

if (cmd === "config" && rest[0] === "get") {
  const [, name, key] = rest;
  if (key === "user.forge.repo") process.stdout.write((REPOS[name!] ?? "") + "\n");
  else if (key === "user.forge.mode") process.stdout.write((MODES[name!] ?? "") + "\n");
  else if (key === "user.forge.role") process.stdout.write((ROLES[name!] ?? "") + "\n");
  else if (key === "user.forge.task") process.stdout.write((TASKS[name!] ?? "") + "\n");
  else process.stdout.write("\n");
  process.exit(0);
}

if (cmd === "info") process.exit(REPOS[rest[0]!] ? 0 : 1);
if (cmd === "image") { process.stdout.write("aaaa1111\n"); process.exit(0); }

// exec : les sondes répondent « rien à signaler », ce qui suffit au câblage.
if (cmd === "exec") {
  // Forme d'un exec via execAsAgent : ["exec", name, "--", "su", "-", "aiuser", "-c", script]
  // une fois le nom du binaire "lxc" tranché — vérifié empiriquement : "--"
  // est à l'indice 2, script à l'indice 7, donc +5.
  const script = argv[argv.indexOf("--") + 5] ?? "";
  if (script.includes("worktree list")) {
    process.stdout.write("worktree /workspace\nworktree /workspace/.trees/cli\n");
  }
  process.exit(0);
}

process.exit(0);
