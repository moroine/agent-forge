// Contexte scripté pour les tests unitaires. `exec` répond selon une table de
// règles ordonnée (première correspondance gagnante, comme un routeur), et
// `prompt` sert une file de réponses préparées.
import type { Context, ExecOptions, ExecResult, Prompt } from "../../cli/lib/context.ts";
import type { FakeIncus } from "./fake-incus.ts";

export type ExecRule = { match: string; code?: number; stdout?: string; stderr?: string };

export type FakeOptions = {
  rules?: ExecRule[];
  answers?: (number | string | null)[];
  tty?: boolean;
  // Faux incus à état : reçoit tout appel `incus …` qu'aucune règle n'a pris.
  incus?: FakeIncus;
};

export type FakeContext = Context & {
  calls: string[][];
  // Aligné index à index sur `calls` : execOptions[i] sont les options passées
  // à l'appel exec qui a produit calls[i]. Séparé de `calls` (et non fusionné
  // dedans) pour ne rien casser des tests existants qui indexent `calls`.
  execOptions: (ExecOptions | undefined)[];
  out_lines: string[];
  err_lines: string[];
};

export function fakeContext(opts: FakeOptions = {}): FakeContext {
  const rules = opts.rules ?? [];
  const answers = [...(opts.answers ?? [])];
  const tty = opts.tty ?? true;
  const calls: string[][] = [];
  const execOptions: (ExecOptions | undefined)[] = [];
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

  return {
    exec,
    attach: async (argv) => { calls.push(argv); return 0; },
    prompt,
    out: (line) => out_lines.push(line),
    err: (line) => err_lines.push(line),
    calls,
    execOptions,
    out_lines,
    err_lines,
  };
}
