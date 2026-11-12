// Contexte scripté pour les tests unitaires. `exec` répond selon une table de
// règles ordonnée (première correspondance gagnante, comme un routeur), et
// `prompt` sert une file de réponses préparées.
import type { AttachOptions, Context, ExecOptions, ExecResult, Prompt } from "../../cli/lib/context.ts";
import type { FakeIncus } from "./fake-incus.ts";

// Les tests unitaires n'héritent jamais de la session herdr du shell qui les lance.
for (const k of ["HERDR_ENV", "HERDR_BIN_PATH", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_CONFIG_PATH"]) {
  delete process.env[k];
}

export type ExecRule = { match: string; code?: number; stdout?: string; stderr?: string; timedOut?: boolean };

export type FakeOptions = {
  rules?: ExecRule[];
  answers?: (number | string | null)[];
  tty?: boolean;
  // Faux incus à état : reçoit tout appel `incus …` qu'aucune règle n'a pris,
  // par exec comme par attach.
  incus?: FakeIncus;
  // Code de sortie rendu par attach (ansible-playbook, agent) ; 0 par défaut.
  attachCode?: number;
  // Codes par commande : la première règle dont `match` est une sous-chaîne de
  // l'argv joint donne son `code` (0 si absent) ; sinon le faux incus pour un
  // appel `incus …`, sinon attachCode.
  attachRules?: ExecRule[];
};

export type FakeContext = Context & {
  calls: string[][];
  // Aligné index à index sur `calls` : execOptions[i] sont les options passées
  // à l'appel exec qui a produit calls[i]. Séparé de `calls` (et non fusionné
  // dedans) pour ne rien casser des tests existants qui indexent `calls`.
  execOptions: (ExecOptions | undefined)[];
  // Appels à attach avec leurs options (env) ; l'argv reste aussi dans `calls`.
  attachCalls: { argv: string[]; opts?: AttachOptions }[];
  out_lines: string[];
  err_lines: string[];
};

export function fakeContext(opts: FakeOptions = {}): FakeContext {
  const rules = opts.rules ?? [];
  const answers = [...(opts.answers ?? [])];
  const tty = opts.tty ?? true;
  const calls: string[][] = [];
  const execOptions: (ExecOptions | undefined)[] = [];
  const attachCalls: { argv: string[]; opts?: AttachOptions }[] = [];
  const out_lines: string[] = [];
  const err_lines: string[] = [];

  const exec = async (argv: string[], callOpts?: ExecOptions): Promise<ExecResult> => {
    calls.push(argv);
    execOptions.push(callOpts);
    const joined = argv.join(" ");
    for (const rule of rules) {
      if (joined.includes(rule.match)) {
        return { code: rule.code ?? 0, stdout: rule.stdout ?? "", stderr: rule.stderr ?? "", ...(rule.timedOut ? { timedOut: true } : {}) };
      }
    }
    // Après les règles : un test peut toujours forcer la réponse d'un appel
    // précis, le faux à état répond au reste.
    if (opts.incus && argv[0] === "incus") return opts.incus.run(argv.slice(1), callOpts?.input);
    return { code: 0, stdout: "", stderr: "" };
  };

  const prompt: Prompt = {
    async pick(label, items) {
      err_lines.push(`${label}> [${items.join(" | ")}]`);
      if (!tty) return null;
      const a = answers.shift();
      if (typeof a !== "number") return null;
      // Le vrai pick ne rend qu'un numéro affiché, de 1 à N : une réponse
      // scriptée hors de ces bornes est une erreur du test, pas une réponse.
      if (!Number.isInteger(a) || a < 1 || a > items.length) {
        throw new Error(`fake pick "${label}": answer ${a} is not between 1 and ${items.length}`);
      }
      return a;
    },
    async ask(label) {
      err_lines.push(`${label}> `);
      if (!tty) return null;
      const a = answers.shift();
      return typeof a === "string" ? a : null;
    },
    async askSecret(label) {
      err_lines.push(`${label}: `);
      if (!tty) return null;
      const a = answers.shift();
      return typeof a === "string" ? a : null;
    },
  };

  const fake: FakeContext = {
    exec,
    sleep: async () => {},
    attach: async (argv, attachOpts) => {
      calls.push(argv);
      attachCalls.push({ argv, opts: attachOpts });
      const joined = argv.join(" ");
      const rule = (opts.attachRules ?? []).find((r) => joined.includes(r.match));
      if (rule) return rule.code ?? 0;
      if (opts.incus && argv[0] === "incus") return opts.incus.run(argv.slice(1)).code;
      return opts.attachCode ?? 0;
    },
    prompt,
    out: (line) => out_lines.push(line),
    err: (line) => err_lines.push(line),
    calls,
    execOptions,
    attachCalls,
    out_lines,
    err_lines,
  };
  return fake;
}
