// La fonction bash à évaluer, plus les deux sous-commandes à sortie machine
// qui l'alimentent — et qui servent aussi de source aux menus interactifs.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";
import { validateRepo } from "../validate.ts";
import { forgeRepos, isRunning, requireContainerForRepo } from "../containers.ts";
import { taskNames } from "../worktrees.ts";

const USAGE = "Usage: forge completion bash|repos|tasks <owner/repo>";

// Chemin absolu du shim `cli/forge`. import.meta.url designe forge.ts ;
// le shim est son voisin, et c'est lui l'executable.
export const FORGE_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "forge");

// La fonction emise appelle forge par CHEMIN ABSOLU, jamais par son nom. Un
// `eval "$(forge completion bash)"` place dans un .bashrc avant la ligne qui
// definit l'alias (ou qui ajoute forge au PATH) ne produit rien du tout, et
// `eval ""` ne definit aucune fonction : la complétion retombe alors
// silencieusement sur les noms de fichiers. Ancrer le chemin supprime cette
// dependance a l'ordre, et rend la fonction independante de la maniere dont
// `forge` est resolu au moment de la complétion.
//
// `resume` propose aussi `--all` à la place du repo ; rien ne le suit.
export function completionScript(forgeBin: string): string {
  return `_forge_completions() {
  local cur cmd
  cur="\${COMP_WORDS[COMP_CWORD]}"
  cmd="\${COMP_WORDS[1]}"

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "setup start resume finish stop delete list image completion" -- "$cur"))
    return
  fi

  case "$cmd" in
    start|resume|finish|stop|delete)
      [ "$cmd" = "resume" ] && [ "\${COMP_WORDS[2]}" = "--all" ] && [ "$COMP_CWORD" -gt 2 ] && return 0
      case "$COMP_CWORD" in
        2)
          local words
          words="$(${forgeBin} completion repos 2>/dev/null)"
          [ "$cmd" = "resume" ] && words="$words --all"
          COMPREPLY=($(compgen -W "$words" -- "$cur")) ;;
        3)
          case "$cmd" in
            start|resume|finish)
              COMPREPLY=($(compgen -W "$(${forgeBin} completion tasks "\${COMP_WORDS[2]}" 2>/dev/null)" -- "$cur")) ;;
            stop|delete)
              COMPREPLY=($(compgen -W "--force" -- "$cur")) ;;
          esac
          ;;
        4) [ "$cmd" = "finish" ] && COMPREPLY=($(compgen -W "--force" -- "$cur")) ;;
      esac
      ;;
    image)      [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "build" -- "$cur")) ;;
    completion) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "bash repos tasks" -- "$cur")) ;;
  esac
  return 0
}
complete -F _forge_completions forge`;
}

export async function cmdCompletion(
  ctx: Context,
  sub: string | undefined,
  repo: string | undefined,
): Promise<number> {
  if (sub === "bash") {
    ctx.out(completionScript(FORGE_BIN));
    return 0;
  }

  if (sub === "repos") {
    for (const r of await forgeRepos(ctx)) ctx.out(r);
    return 0;
  }

  if (sub === "tasks") {
    if (!repo) throw new ForgeError(USAGE);
    validateRepo(repo);
    const container = await requireContainerForRepo(ctx, repo);
    // Container arrêté : rien à lister, mais ce n'est pas une erreur — on ne
    // peut simplement pas l'inspecter.
    if (!(await isRunning(ctx, container))) return 0;
    for (const t of await taskNames(ctx, container)) ctx.out(t);
    return 0;
  }

  throw new ForgeError(USAGE);
}
