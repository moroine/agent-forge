// Contexte scripté pour les tests unitaires. `exec` répond selon une table de
// règles ordonnée (première correspondance gagnante, comme un routeur), et
// `prompt` sert une file de réponses préparées.
import type { AttachOptions, Context, ExecOptions, ExecResult, Prompt } from "../../cli/lib/context.ts";
import type { FakeIncus } from "./fake-incus.ts";

// Les tests unitaires n'héritent jamais de la session herdr du shell qui les lance.
for (const k of ["HERDR_ENV", "HERDR_BIN_PATH", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_CONFIG_PATH"]) {
  delete process.env[k];
}

export type ExecRule = { match: string; code?: number; stdout?: string; stderr?: string };

export type FakeOptions = {
  rules?: ExecRule[];
  answers?: (number | string | null)[];
  tty?: boolean;
  // Faux incus à état : reçoit tout appel `incus …` qu'aucune règle n'a pris.
  incus?: FakeIncus;
  // Code de sortie rendu par attach (ansible-playbook, agent) ; 0 par défaut.
  attachCode?: number;
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
  // Nombre d'appels à ctx.attention().
  attentions: number;
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
        return { code: rule.code ?? 0, stdout: rule.stdout ?? "", stderr: rule.stderr ?? "" };
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
      return typeof a === "number" ? a : null;
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
    attach: async (argv, attachOpts) => { calls.push(argv); attachCalls.push({ argv, opts: attachOpts }); return opts.attachCode ?? 0; },
    prompt,
    out: (line) => out_lines.push(line),
    err: (line) => err_lines.push(line),
    attention: () => { fake.attentions++; },
    calls,
    execOptions,
    attachCalls,
    out_lines,
    err_lines,
    attentions: 0,
  };
  return fake;
}
