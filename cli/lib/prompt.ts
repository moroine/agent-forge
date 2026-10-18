// Menus numérotés sur node:readline. Contrat : la liste et l'invite vont sur
// stderr, la réponse est rendue à l'appelant, et rien n'est demandé quand on
// ne peut pas demander.
import { createInterface } from "node:readline";
import type { Prompt } from "./context.ts";

type MaybeTTY = NodeJS.ReadableStream & { isTTY?: boolean };

export function createPrompt(
  input: MaybeTTY = process.stdin,
  err: (s: string) => void = (s) => { process.stderr.write(s); },
): Prompt {
  // Une interface par appel de haut niveau (un pick() ou un ask() entier,
  // pas une ligne), fermée dans le finally dès que cet appel se résout.
  // La partager sur toute la boucle de relance d'un même pick() est ce qui
  // évite de perdre les lignes déjà mises en tampon par readline quand un
  // chunk contient plusieurs réponses (le cas normal d'un flux non
  // interactif). Mais readline ne se ferme tout seul que si le flux se
  // termine — un vrai TTY interactif n'émet jamais 'end' — donc sans ce
  // close() explicite l'interface garde stdin résumé et son listener
  // 'data' attaché après la résolution de l'appel, ce qui volerait les
  // frappes destinées à un attach() lancé ensuite (ex. l'attach de
  // l'agent en stdio "inherit"). D'où le close() explicite ici, pas de
  // raccourci possible.
  async function withReadLine<T>(fn: (next: () => Promise<string | null>) => Promise<T>): Promise<T> {
    const rl = createInterface({ input, terminal: false });
    const lines = rl[Symbol.asyncIterator]();
    const next = async (): Promise<string | null> => {
      const { value, done } = await lines.next();
      return done ? null : value;
    };
    try {
      return await fn(next);
    } finally {
      rl.close();
    }
  }

  return {
    async pick(label, items) {
      // Rien à choisir, ou personne pour répondre : on ne touche pas à stdin.
      // Le lire ici consommerait une entrée destinée à quelqu'un d'autre.
      if (items.length === 0) return null;
      if (!input.isTTY) return null;

      return withReadLine(async (next) => {
        for (;;) {
          items.forEach((item, i) => err(`${String(i + 1).padStart(2)}) ${item}\n`));
          err(`${label}> `);
          const answer = await next();
          if (answer === null) return null;
          const n = Number(answer.trim());
          if (Number.isInteger(n) && n >= 1 && n <= items.length) return n;
          err("Invalid choice.\n");
        }
      });
    },

    async ask(label) {
      if (!input.isTTY) return null;

      return withReadLine(async (next) => {
        err(`${label}> `);
        const answer = await next();
        if (answer === null) return null;
        const value = answer.trim();
        return value === "" ? null : value;
      });
    },

    // Le PAT ne doit pas s'afficher : node:readline échoue par défaut, il faut
    // passer stdin en raw et consommer les octets à la main.
    async askSecret(label) {
      const stdin = input as NodeJS.ReadStream;
      if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return null;
      err(`${label}: `);
      return new Promise<string | null>((resolve) => {
        let buf = "";
        const cleanup = () => {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdin.off("end", onEnd);
          stdin.off("error", onEnd);
          err("\n");
        };
        // Sans ces deux-là, un stdin qui se ferme à l'invite du token (pipe
        // fermé, ligne série coupée) ne résout JAMAIS la promesse : forge
        // reste pendu indéfiniment. `read -s` en bash rendait un code non nul
        // sur EOF ; on rend null, que provisionContainer traduit déjà en
        // « empty token ». Même chemin de nettoyage, donc le terminal est
        // rendu dans tous les cas.
        const onEnd = () => { cleanup(); resolve(null); };
        const onData = (chunk: Buffer) => {
          for (const ch of chunk.toString("utf8")) {
            if (ch === "\r" || ch === "\n") { cleanup(); resolve(buf === "" ? null : buf); return; }
            if (ch === "\u0003") { cleanup(); resolve(null); return; }   // Ctrl-C
            if (ch === "\u007f") { buf = buf.slice(0, -1); continue; }   // backspace
            buf += ch;
          }
        };
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on("data", onData);
        stdin.on("end", onEnd);
        stdin.on("error", onEnd);
      });
    },
  };
}
