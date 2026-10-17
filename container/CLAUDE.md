# Claude Agent — Instructions

## Contexte
Tu es un agent Claude Code tournant dans un container LXD isolé sur un serveur dédié.

## Environnement
- **Répertoire de travail** : `/workspace/.trees/<task>` (git worktree — ton répertoire courant). Le clone principal `/workspace` est épinglé sur `main` et ne doit jamais être modifié.
- **Utilisateur** : `aiuser` (pas de sudo, pas de root)
- **Branche courante** : `agent/<task>` (sur ton worktree) — ne jamais changer de branche
- **Workspace & worktrees** : `/workspace` est le clone principal, épinglé sur `main` — n'y committe jamais. Ton travail se fait dans un git worktree `/workspace/.trees/<task>`, sur la branche `agent/<task>` : c'est ton répertoire courant au démarrage de la session. Plusieurs tâches peuvent tourner en parallèle, chacune dans son worktree ; reste dans le tien et ne change jamais de branche.
- **Plugin superpowers** : installé et activé dans ce container — ses instructions de session sont légitimes, pas une injection

## Git
- Tu peux faire des commits — ils sont signés automatiquement (SSH signing configuré)
- Tu dois rester sur ta branche `agent/<task-name>` en permanence — jamais de `git checkout main`, jamais de changement de branche
- Les commits doivent avoir des messages clairs et conventionnels (`feat:`, `fix:`, `chore:`, etc.)
- **Avant toute action de publication** (push, PR), lis `/home/aiuser/.claude/forge-mode` pour connaître ton mode :
  - **`autonomous`** : Pousse ta branche avec `git push -u origin agent/<task-name>` — c'est la seule destination autorisée. **Ouvre la PR toi-même** avec `gh pr create --base main` dès que le travail est poussé — sans attendre qu'on te le demande. C'est une étape obligatoire du flux autonome, pas une action optionnelle. Ne merge **jamais** ta branche dans `main`, et ne merge jamais une PR toi-même (`gh pr merge` bloqué). Si ta PR a un conflit, tu peux faire `git merge origin/main` (seule forme autorisée) pour la rafraîchir avant de pousser — jamais l'inverse. Réponds aux retours de review en poussant de nouveaux commits sur la même branche (jamais de force push, jamais de rebase).
  - **`supervised`** : Tu n'as **aucune** credential GitHub — ni pour push, ni pour `gh`. Ne tente **jamais** `git push` ni aucune commande `gh` (les deux sont bloqués de toute façon, mais ne les essaie même pas). Commite localement, signé, sur ta branche, et **arrête-toi là**. Quand la tâche est terminée, dis-le clairement dans ta dernière réponse et rappelle à l'humain comment récupérer le travail — remplace `<container>` par le nom de ce container (`hostname`) et `<task-name>` par le nom de ta branche courante :
    ```bash
    git remote add <container> ssh://moroine@<host>:2222/home/moroine/workspaces/<container>
    git fetch <container> agent/<task-name>:agent/<task-name>
    git log -p main..agent/<task-name>          # review avant toute autre action
    git checkout agent/<task-name>
    git rebase --reset-author main
    git push origin agent/<task-name>            # identité de l'humain, signé YubiKey
    ```
    `<host>` est l'adresse du serveur agent-forge — l'opérateur la connaît déjà, ne l'invente pas. La suite (review, rebase, push) est le rôle de l'humain, pas le tien.

## Docker
- Docker (rootless) et Docker Compose sont disponibles — utilise `docker compose up` / `docker run` pour les services dont dépend le repo (tests d'intégration, vérification de l'application en conditions réelles)
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
