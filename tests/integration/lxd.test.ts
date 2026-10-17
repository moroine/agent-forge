// Couche 3 : le VRAI lxc, sur l'hôte LXD, en opt-in.
//
//   FORGE_INTEGRATION=1 npm run test:integration
//   FORGE_INTEGRATION=1 npm run test:integration -- --capture
//
// Un échec ici signifie que le faux a dérivé du réel : les assertions
// impriment donc la commande et sa sortie BRUTES, pour être collées telles
// quelles dans une discussion de design.
import { test, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ENABLED = process.env.FORGE_INTEGRATION === "1";
const CAPTURE = process.argv.includes("--capture");
const PROJECT = "forge-selftest";
const SENTINEL = "forge-selftest/throwaway";

let conf: string;
let container: string;

function lxc(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("lxc", args, { encoding: "utf8", env: { ...process.env, ...env } });
}
// Le CLI est dirigé vers le projet de test par un LXD_CONF isolé. Jamais
// `lxc project switch` : cela changerait le projet courant de l'opérateur.
const inProject = (args: string[]) => lxc(args, { LXD_CONF: conf });

function raw(label: string, r: { status: number | null; stdout: string; stderr: string }) {
  return `${label}\n  exit=${r.status}\n  stdout=${JSON.stringify(r.stdout)}\n  stderr=${JSON.stringify(r.stderr)}`;
}

before((t) => {
  // `before` est typé (TestContext | SuiteContext) côté node:test, mais au
  // niveau module (pas dans un describe) c'est toujours un TestContext.
  if (!ENABLED) return (t as TestContext).skip("set FORGE_INTEGRATION=1 to run against a real LXD host");

  const probe = lxc(["--version"]);
  assert.equal(probe.status, 0, raw("no usable lxc client", probe));

  // Nettoyage d'un résidu de run tué, AVANT de tenter la suppression du
  // projet : LXD refuse `project delete` tant qu'il reste quoi que ce soit
  // dedans, donc un container oublié ferait échouer la suppression puis la
  // recréation ("already exists"), forçant un nettoyage manuel — exactement
  // ce que ce bloc évite. On énumère avec `--project` (jamais
  // `lxc project switch`, qui muterait le projet courant de l'opérateur, et
  // ce avant même que le LXD_CONF isolé existe) et on ne supprime que ce qui
  // porte à la fois notre préfixe de nom ET la sentinelle — même double
  // garde que le teardown de after(). Un statut non nul ici signifie très
  // probablement que le projet n'existe pas encore (premier run) : ce n'est
  // pas une erreur, on continue simplement sans rien à nettoyer.
  const stray = lxc(["--project", PROJECT, "list", "-f", "json"]);
  if (stray.status === 0) {
    let instances: { name: string }[] = [];
    try {
      const parsed: unknown = JSON.parse(stray.stdout);
      if (Array.isArray(parsed)) instances = parsed as { name: string }[];
    } catch {
      // Sortie inattendue : on laisse `project create` échouer plus bas et
      // remonter l'erreur brute plutôt que de deviner quoi supprimer.
    }
    for (const inst of instances) {
      if (!inst.name.startsWith("agent-forge-selftest-")) continue;
      const repo = lxc(["--project", PROJECT, "config", "get", inst.name, "user.forge.repo"]).stdout.trim();
      if (repo === SENTINEL) {
        lxc(["--project", PROJECT, "delete", inst.name, "--force"]);
      } else {
        // Porte notre préfixe mais pas la sentinelle : on n'y touche pas.
        // Le `project create` qui suit échouera bruyamment si le projet
        // n'est pas vide, ce qui est le comportement voulu.
        console.error(raw(
          `WARNING: leaving unrecognised instance ${inst.name} (repo=${JSON.stringify(repo)}) in ${PROJECT} alone`,
          stray,
        ));
      }
    }
  }

  // Projet dédié. features.images=false hérite des images du projet par
  // défaut, donc agent-base reste visible sans copie.
  lxc(["project", "delete", PROJECT]);            // résidu d'un run tué, maintenant vide (ou absent)
  const created = lxc(["project", "create", PROJECT,
    "-c", "features.images=false", "-c", "features.profiles=false"]);
  assert.equal(created.status, 0, raw("could not create the test project", created));

  conf = mkdtempSync(join(tmpdir(), "forge-lxdconf-"));
  // `join()` de segments non vides n'est jamais falsy : un `if (real)` ne
  // teste rien. Ce qu'il faut vérifier, c'est que HOME est bien défini et
  // que la source existe — sinon on laisse l'échec de cpSync être explicite
  // plutôt que de deviner un chemin relatif erroné.
  if (process.env.HOME && existsSync(join(process.env.HOME, ".config", "lxc"))) {
    const real = join(process.env.HOME, ".config", "lxc");
    cpSync(real, conf, { recursive: true, errorOnExist: false, force: true });
  }
  // Dans la copie isolée. Le résultat DOIT être vérifié : si LXD_CONF n'est
  // pas honoré — le seul mécanisme que la spec signale comme non vérifié —
  // ce switch part sur la config réelle de l'opérateur, et tout le run
  // s'exécute dans SON projet par défaut, y créant des containers à côté de
  // son vrai travail au lieu d'échouer bruyamment.
  const switched = lxc(["project", "switch", PROJECT], { LXD_CONF: conf });
  assert.equal(switched.status, 0,
    raw(`could not switch the isolated LXD_CONF (${conf}) to project ${PROJECT}`, switched));

  container = `agent-forge-selftest-${Math.random().toString(36).slice(2, 8)}`;
  // init, jamais start : ni réseau, ni cgroups, ni PAT, ni GitHub.
  const init = inProject(["init", "agent-base", container]);
  assert.equal(init.status, 0, raw("lxc init agent-base failed", init));
  inProject(["config", "set", container, "user.forge.repo", SENTINEL]);
  inProject(["config", "set", container, "user.forge.mode", "supervised"]);
});

after(() => {
  if (!ENABLED) return;
  // `container` et `conf` ne sont affectés que plus loin dans before() (conf
  // juste après le `project create` réussi, container juste avant le `lxc
  // init`) : si before() a jeté avant l'un des deux — client lxc absent,
  // projet non créable —, after() tourne quand même (node:test le garantit
  // même quand before() a jeté) et ne doit ni planter dessus ni sauter le
  // nettoyage de ce qui EST là. Chaque étape est indépendante : l'échec de
  // l'une ne doit pas empêcher les suivantes.
  if (container) {
    // Double garde : le préfixe de nom ET la sentinelle doivent correspondre.
    const repo = inProject(["config", "get", container, "user.forge.repo"]).stdout.trim();
    if (container.startsWith("agent-forge-selftest-") && repo === SENTINEL) {
      inProject(["delete", container, "--force"]);
    }
  }
  // `project delete` refuse de partir s'il reste quoi que ce soit dedans :
  // c'est LXD qui vérifie, pas nous. On tente même sans container connu : le
  // projet a pu être créé avant un échec plus tardif dans before().
  const removed = lxc(["project", "delete", PROJECT]);
  if (removed.status !== 0) {
    console.error(raw(`WARNING: project ${PROJECT} not deleted — inspect it`, removed));
  }
  if (conf) rmSync(conf, { recursive: true, force: true });
});

function forge(args: string[]) {
  return spawnSync(resolve("cli/forge"), args, {
    encoding: "utf8",
    env: { ...process.env, LXD_CONF: conf },
  });
}

test("lxc list -f json still has the name and status fields the CLI reads", { skip: !ENABLED }, () => {
  const r = inProject(["list", "-f", "json"]);
  assert.equal(r.status, 0, raw("lxc list failed", r));
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed), raw("lxc list is not an array", r));
  const mine = parsed.find((i: { name: string }) => i.name === container);
  assert.ok(mine, raw(`${container} missing from lxc list`, r));
  assert.equal(typeof mine.status, "string", raw("status is not a string", r));
  if (CAPTURE) {
    mkdirSync(resolve("tests/fixtures"), { recursive: true });
    writeFileSync(resolve("tests/fixtures/lxc-list.json"), r.stdout);
  }
});

test("forge list shows the throwaway container", { skip: !ENABLED }, () => {
  const r = forge(["list"]);
  assert.equal(r.status, 0, raw("forge list failed", r));
  assert.match(r.stdout, /^REPO\s+MODE\s+STATE\s+BUILD$/m);
  assert.ok(r.stdout.includes(SENTINEL), raw("sentinel repo not listed", r));
});

test("forge completion repos lists it, one per line", { skip: !ENABLED }, () => {
  const r = forge(["completion", "repos"]);
  assert.equal(r.status, 0, raw("completion repos failed", r));
  assert.ok(r.stdout.split("\n").includes(SENTINEL), raw("sentinel repo missing", r));
});

test("forge completion tasks on a stopped container prints nothing and succeeds", { skip: !ENABLED }, () => {
  const r = forge(["completion", "tasks", SENTINEL]);
  assert.equal(r.status, 0, raw("completion tasks failed", r));
  assert.equal(r.stdout.trim(), "", raw("expected no tasks", r));
});

test("config get returns the stamped value, and empty for an unset key", { skip: !ENABLED }, () => {
  const set = inProject(["config", "get", container, "user.forge.repo"]);
  assert.equal(set.stdout.trim(), SENTINEL, raw("unexpected repo stamp", set));
  const unset = inProject(["config", "get", container, "user.forge.nonexistent"]);
  assert.equal(unset.stdout.trim(), "", raw("an unset key should be empty", unset));
  if (CAPTURE) {
    mkdirSync(resolve("tests/fixtures"), { recursive: true });
    writeFileSync(resolve("tests/fixtures/lxc-config-get.txt"), set.stdout);
  }
});

// Le faux lxc (tests/lib/fake-lxc.ts) ne lit pas cette fixture — sa liste est
// intégrée en dur, voir son commentaire d'en-tête. Le rôle de --capture est
// donc différent : figer la FORME réelle de `lxc list -f json`, pour que ce
// test-ci détecte une dérive (LXD change son format) sans dépendre d'un hôte
// LXD. Ni ENABLED ni FORGE_INTEGRATION ne sont requis ici — seulement que la
// fixture existe.
test("captured lxc-list.json fixture parses into the shape lxd.ts expects", (t) => {
  const path = resolve("tests/fixtures/lxc-list.json");
  if (!existsSync(path)) {
    t.skip("no captured fixture yet — run with --capture on a real LXD host first");
    return;
  }
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed), `captured fixture is not an array:\n${raw}`);
  for (const entry of parsed) {
    assert.equal(typeof entry.name, "string", `entry missing string name:\n${JSON.stringify(entry)}`);
    assert.equal(typeof entry.status, "string", `entry missing string status:\n${JSON.stringify(entry)}`);
  }
});
