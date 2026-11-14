// La fonction bash à évaluer, plus la sous-commande à sortie machine qui
// l'alimente — et qui sert aussi de source aux menus interactifs.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";
import { forgeRepos } from "../containers.ts";

const USAGE = "Usage: forge completion bash|repos";

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
export function completionScript(forgeBin: string): string {
  return `_forge_completions() {
  local cur cmd
  cur="\${COMP_WORDS[COMP_CWORD]}"
  cmd="\${COMP_WORDS[1]}"

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "setup stop delete list egress image team api completion" -- "$cur"))
    return
  fi

  case "$cmd" in
    stop|delete)
      case "$COMP_CWORD" in
        2) COMPREPLY=($(compgen -W "$(${forgeBin} completion repos 2>/dev/null)" -- "$cur")) ;;
        3) COMPREPLY=($(compgen -W "--force" -- "$cur")) ;;
      esac
      ;;
    egress)
      case "$COMP_CWORD" in
        2) COMPREPLY=($(compgen -W "log $(${forgeBin} completion repos 2>/dev/null)" -- "$cur")) ;;
        3)
          if [ "\${COMP_WORDS[2]}" = "log" ]; then
            COMPREPLY=($(compgen -W "$(${forgeBin} completion repos 2>/dev/null)" -- "$cur"))
          else
            COMPREPLY=($(compgen -W "strict open" -- "$cur"))
          fi
          ;;
      esac
      ;;
    image)      [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "build" -- "$cur")) ;;
    api)        [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "serve" -- "$cur")) ;;
    team)       [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "converge assign release status sync" -- "$cur")) ;;
    completion) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "bash repos" -- "$cur")) ;;
  esac
  return 0
}
complete -F _forge_completions forge`;
}

export async function cmdCompletion(
  ctx: Context,
  sub: string | undefined,
): Promise<number> {
  if (sub === "bash") {
    ctx.out(completionScript(FORGE_BIN));
    return 0;
  }

  if (sub === "repos") {
    for (const r of await forgeRepos(ctx)) ctx.out(r);
    return 0;
  }

  throw new ForgeError(USAGE);
}
