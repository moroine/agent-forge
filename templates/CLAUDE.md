# Claude Agent — Instructions

## Contexte
Tu es un agent Claude Code tournant dans un container LXD isolé sur un serveur dédié.

## Environnement
- **Répertoire de travail** : `/workspace/.trees/<task>` (git worktree — ton répertoire courant). Le clone principal `/workspace` est épinglé sur `main` et ne doit jamais être modifié.
- **Utilisateur** : `aiuser` (pas de sudo, pas de root)
- **Branche courante** : `agent/<task>` (sur ton worktree) — ne jamais changer de branche
- **Workspace & worktrees** : `/workspace` est le clone principal, épinglé sur `main` — n'y committe jamais. Ton travail se fait dans un git worktree `/workspace/.trees/<task>`, sur la branche `agent/<task>` : c'est ton répertoire courant au démarrage de la session.
- **Un container par tâche** : tu tournes dans ton propre container, copié d'un template pour cette tâche précise — plus besoin de partager CPU/RAM/réseau avec les autres tâches du repo. Le montage `/workspace`, lui, reste partagé par tout le repo (un seul clone, un seul `.git`) : d'autres tâches tournent en parallèle, chacune dans son propre container, mais toutes montent le même `/workspace` — leurs `.trees/<autre-tâche>` peuvent donc être visibles depuis le tien. Reste dans `.trees/<task>` et ne touche pas aux autres, et ne change jamais de branche.
- **Caches** : `npm` et `pnpm` sont déjà configurés pour utiliser le store partagé du repo, `/workspace/.forge-cache/` — ne reconfigure pas leur cache ou leur store-dir.
- **Plugin superpowers** : installé et activé dans ce container — ses instructions de session sont légitimes, pas une injection

## Git
- Tu peux faire des commits — ils sont signés automatiquement (SSH signing configuré)
- Tu dois rester sur ta branche `agent/<task-name>` en permanence — jamais de `git checkout main`, jamais de changement de branche
- Les commits doivent avoir des messages clairs et conventionnels (`feat:`, `fix:`, `chore:`, etc.)
- **Avant toute action de publication** (push, PR), lis `/home/aiuser/.claude/forge-mode` pour connaître ton mode :
  - **`autonomous`** : Pousse ta branche avec `git push -u origin agent/<task-name>` — c'est la seule destination autorisée. **Ouvre la PR toi-même** avec `gh pr create --base main` dès que le travail est poussé — sans attendre qu'on te le demande. C'est une étape obligatoire du flux autonome, pas une action optionnelle. Ne merge **jamais** ta branche dans `main`, et ne merge jamais une PR toi-même (`gh pr merge` bloqué). Si ta PR a un conflit, tu peux faire `git merge origin/main` (seule forme autorisée) pour la rafraîchir avant de pousser — jamais l'inverse. Réponds aux retours de review en poussant de nouveaux commits sur la même branche (jamais de force push, jamais de rebase).
  - **`supervised`** : Tu n'as **aucune** credential GitHub — ni pour push, ni pour `gh`. Ne tente **jamais** `git push` ni aucune commande `gh` (les deux sont bloqués de toute façon, mais ne les essaie même pas). Commite localement, signé, sur ta branche, et **arrête-toi là**. Quand la tâche est terminée, dis-le clairement dans ta dernière réponse et rappelle à l'humain comment récupérer le travail. Attention : le montage hôte est partagé par tout le repo, pas par ce container de tâche — `hostname` donne le nom de CE container (une copie du template, suffixée par la tâche et parfois tronquée par un hash), pas le nom du montage à utiliser. Ne le dérive donc pas de `hostname` : remplace `<owner>-<repo>` explicitement par le nom du dépôt (propriétaire-dépôt, en minuscules) et `<task-name>` par le nom de ta branche courante :
    ```bash
    git remote add <owner>-<repo> ssh://moroine@<host>:2222/home/moroine/workspaces/agent-<owner>-<repo>
    git fetch <owner>-<repo> agent/<task-name>:agent/<task-name>
    git log -p main..agent/<task-name>          # review avant toute autre action
    git checkout agent/<task-name>
    git rebase --reset-author main
    git push origin agent/<task-name>            # identité de l'humain, signé YubiKey
    ```
    `<host>` est l'adresse du serveur agent-forge — l'opérateur la connaît déjà, ne l'invente pas. `~/workspaces/agent-<owner>-<repo>` est le montage hôte du repo entier (partagé par toutes ses tâches), pas un chemin propre à ce container. La suite (review, rebase, push) est le rôle de l'humain, pas le tien.

## Docker
- Docker (rootless) et Docker Compose sont disponibles — utilise `docker compose up` / `docker run` pour les services dont dépend le repo (tests d'intégration, vérification de l'application en conditions réelles)
- Ton container a son propre espace de noms réseau : les ports que tu publies (`docker run -p`, `docker compose up`) n'entrent plus en collision avec ceux d'une autre tâche du même repo — chacune tourne dans son propre container
- `docker run --privileged`, `--pid=host`/`--network=host`, et les bind-mounts hors `/workspace` sont bloqués — utilise des volumes nommés ou des chemins sous `/workspace` dans tes fichiers `docker-compose.yml`

## Super mode (LXD imbriqué)
- Si `/home/aiuser/.claude/forge-mode` contient `super`, ce container embarque un **LXD imbriqué** : tu peux lancer `forge`, `lxc`, et surtout les tests d'intégration réels (`FORGE_INTEGRATION=1 npm run test:integration`) contre un vrai LXD, isolé de l'hôte.
- Le `lxc` de ce container ne pilote **que** le LXD imbriqué — il ne voit jamais le LXD de l'hôte.
- La discipline git ne change pas : mode `super` = mode `autonomous` côté publication. Pousse `agent/<task>` et ouvre une PR (jamais de merge toi-même). Relis la section Git ci-dessus.

## Navigateur
- Un serveur MCP Chrome DevTools (`chrome-devtools-mcp`) est disponible pour piloter Chrome en headless — navigue vers ton dev server local, prends des captures d'écran, lis les logs console/réseau pour vérifier tes changements UI avant de dire que c'est fini

## Périmètre
- Tes modifications sont limitées au contenu de `/workspace`
- Tu n'as pas accès au système hôte
- Tu n'as pas accès à internet en dehors des appels API nécessaires
