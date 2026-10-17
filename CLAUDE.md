# agent-forge — Instructions pour Claude

## Contexte
Tu travailles sur `agent-forge`, un repo d'infrastructure pour déployer des agents Claude Code dans des containers Incus isolés, sur un hôte provisionné par Ansible (une VM) ou directement sur la machine de dev (mode local).

Ce fichier décrit la v2, portée par la branche `next` (voir « Branche `next` » plus bas) ; `main` reste la v1 (LXD) jusqu'à la sortie. Sur `next`, les sous-projets 1 (hôte Ansible) et 2 (runtime Incus) sont livrés ; 3 (allowlist d'egress), 4 (herdr) et 5 (mode local et docs) restent à faire. Le `README.md` décrit encore la v1 jusqu'au sous-projet 5.

## Stack
- **Hôte** : Ubuntu 26.04 LTS, Incus 7.0 LTS (dépôt Zabbly), nftables (table `inet forge_host`), fail2ban — provisionné par `ansible/site.yml`
- **Runtime Incus** : projet `agent-forge`, bridge `forgebr0`, ACL `forge-egress`, profil `agent-forge` — créés par `forge setup`
- **Image** `agent-base` : `images:ubuntu/26.04`, Node.js 24, pnpm, Claude Code, Google Chrome headless + `chrome-devtools-mcp`, Docker rootless — construite par `forge image build`
- **CLI** : `forge`, en TypeScript exécuté par Node (`cli/`)
- **User agent** : `aiuser` (UID/GID 1001, no sudo, scoped to `/workspace`)
- **Auth** : SSH Ed25519, YubiKey ; aucune credential GitHub dans les containers (l'hôte clone avec l'agent SSH de l'utilisateur)

## Périmètre
- CLI dans `cli/` (`cli/forge`, `cli/forge.ts`, `cli/lib/`)
- Fichiers poussés dans les containers dans `container/`
- Playbooks et rôles Ansible dans `ansible/`
- Config files hôte de la v1 dans `config/`
- Documentation dans `README.md`

## Conventions

### Git
- Branche de travail : `agent/<tâche>`, une par tâche
- Commits signés automatiquement là où une clé est configurée (machine de dev, container v1) ; dans un container v2 ils sont non signés (voir « Runtime v2 »)
- Messages conventionnels : `feat:`, `fix:`, `chore:`, `docs:`
- Ne jamais toucher à `main` directement : jamais de `git checkout main`, jamais de push vers `main`, jamais de merger une PR toi-même
- La seule forme de `git merge` autorisée est `git merge origin/main` (ou `--no-edit`), pour rafraîchir ta branche `agent/*` avec les derniers changements de `main` avant de pousser — jamais l'inverse (merger ta branche vers `main`), jamais une autre branche/commit. C'est ce que `pre-bash.sh` autorise explicitement (tout le reste de `git merge` reste bloqué).
- En mode autonome (permission-mode `auto` — que ce soit cette session ou un container provisionné par `forge start`) : push autorisé uniquement vers `agent/<branche>` (`git push -u origin agent/<branche>`), puis ouverture d'une PR avec `gh pr create --base main`. Jamais de merge automatique de la PR — elle est revue et mergée par un humain. C'est le même flux que le "Autonomous PR flow" documenté dans `README.md`.
- En dehors du mode autonome (session interactive), demander confirmation avant tout push, même vers `agent/<branche>`

### Branche `next` (v2 en cours)
Cette branche porte la v2 d'agent-forge (Incus, hôte Ansible, herdr — spec
cadre `docs/superpowers/specs/2026-10-15-v2-incus-ansible-herdr-design.md`).
`main` reste la v1 jusqu'à la sortie de la v2. Sur cette branche, ce qui suit
remplace les mentions de `main` comme base dans la section Git ci-dessus :
- Les tâches v2 partent de `next` (`forge start` → « other branch… » →
  `origin/next`) : ta branche de base est `next`.
- Les PR visent `next` : `gh pr create --base next`, jamais `--base main`.
- Pour rafraîchir ta branche `agent/*` : `git merge origin/next` (ou
  `--no-edit`), autorisé par `pre-bash.sh` dès que la règle correspondante est
  en place sur `main`.
- `main` est fusionnée dans `next` régulièrement, par un humain.

### Runtime v2
Specs : `docs/superpowers/specs/2026-10-15-v2-runtime-design.md` (runtime) et
`docs/superpowers/specs/2026-10-15-v2-host-ansible-design.md` (hôte).
- Règle de frontière : Ansible ne configure jamais l'intérieur d'Incus, et
  `forge` ne touche jamais l'OS hôte.
- Le CLI appelle `incus --project agent-forge` ; le bridge et l'ACL vivent
  dans le projet `default`.
- `forge setup` est idempotent : une fois par hôte, et de nouveau après un
  changement de `~/.config/agent-forge/config.json`. Il vérifie en lecture
  seule le contrat hôte (pas root, firewall nftables, sysctls userns, pool de
  stockage, `ip_forward`). Puis il converge le projet `agent-forge`, le bridge
  `forgebr0`, l'ACL `forge-egress` et le profil `agent-forge`.
- `forge image build` pilote le cycle de vie de l'image : instance
  `forge-image-build`, publication sous `agent-base`, marquage
  `user.forge.commit`. La configuration de l'instance est faite par Ansible,
  `ansible/image.yml` (rôle `forge_image`), via la connexion
  `community.general.incus`.
- Containers `supervised` uniquement : pas de PAT, pas de `gh`, pas de clé de
  signature, pas de compte bot. Les modes `autonomous` et `super` sont des
  non-objectifs de la v2.0. Le concept de mode reste (marqueur
  `~/.claude/forge-mode`, règles autonomous de `container/pre-bash.sh`).
- Les commits de l'agent portent l'identité git de l'hôte (`user.name` et
  `user.email` du `git config --global` de l'utilisateur forge) et sont non
  signés (`commit.gpgsign=false`). L'utilisateur les re-signe en publiant.
- tmux reste dans le container jusqu'au sous-projet 4, qui le remplace par
  herdr.
- Les tests unitaires tournent avec un faux `incus`. Les tests d'intégration
  réels (`FORGE_INTEGRATION=1`) demandent un Incus de test jetable : ils ne
  tournent pas dans un container super v1, qui embarque un LXD imbriqué et non
  Incus.

Le mode super (LXD imbriqué, `[u]` au `forge start`, image `agent-base-super`,
profil `agent-super`) n'existe que dans la v1, sur `main`.

### Scripts
- Bash strict mode : `set -e` obligatoire
- Variables entre guillemets : `"$VAR"` pas `$VAR`
- Commenter les blocs non évidents
- Tester les préconditions en début de script (ex: vérifier qu'un container existe avant d'y entrer)

### Sécurité
- Ne jamais hardcoder de credentials, clés, tokens
- Aucune valeur personnelle (chemin, UID, identité, hôte) dans le CLI, l'image ou `container/` : tout ce qui est personnel est injecté au `forge start`
- Aucune clé SSH ni credential GitHub dans les containers ou dans l'image : l'hôte clone avec l'agent SSH de l'utilisateur
- UID mapping : le `raw.idmap` du profil `agent-forge` est calculé par `forge setup` depuis l'UID/GID de l'utilisateur forge (`uid <uid> 1001`, `gid <gid> 1001`). Un fichier créé par `aiuser` dans `/workspace` appartient à l'utilisateur forge sur l'hôte. Aucun UID en dur ; `forge` refuse de tourner en root
- Toute nouvelle règle nftables (rôle `firewall`, table `inet forge_host`) ou d'ACL Incus doit être justifiée en commentaire ; jamais de `flush ruleset`, qui effacerait les tables d'Incus

## Ce que tu peux faire
- Modifier `cli/forge`, `cli/forge.ts` et `cli/lib/`
- Mettre à jour le template `container/CLAUDE.md`
- Mettre à jour `README.md`
- Mettre à jour les config files

## Ce que tu ne dois pas faire
- Modifier les clés SSH ou credentials
- Changer l'architecture de sécurité sans validation explicite
- Push sur `main`, ou merger une PR toi-même (même en mode autonome)
- Exécuter des commandes sur le système hôte en dehors de `/workspace`
