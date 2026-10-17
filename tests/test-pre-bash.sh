#!/bin/bash
# Tests du hook pre-bash.sh.
# Simule Claude Code : envoie {"tool_input":{"command":...}} sur stdin
# et vérifie allow (exit 0) vs block (exit 2).
# Prérequis : jq. Lancer : bash tests/test-pre-bash.sh
# (le hook n'utilise que grep -E POSIX : fonctionne avec BSD grep comme GNU grep)
set -e

HOOK="$(cd "$(dirname "$0")/.." && pwd)/container/pre-bash.sh"
PASS=0
FAIL=0

run_hook() {
  printf '{"tool_input":{"command":%s}}' "$(jq -Rn --arg c "$1" '$c')" \
    | bash "$HOOK" > /dev/null 2>&1
}

expect_allow() {
  local rc=0
  run_hook "$1" || rc=$?
  if [ "$rc" -eq 0 ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu ALLOW, rc=$rc): $1"
  fi
}

expect_block() {
  local rc=0
  run_hook "$1" || rc=$?
  if [ "$rc" -eq 2 ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu BLOCK, rc=$rc): $1"
  fi
}

MODE_FILE=$(mktemp)
trap 'rm -f "$MODE_FILE"' EXIT

run_hook_as() {
  local mode="$1" cmd="$2"
  printf '%s' "$mode" > "$MODE_FILE"
  FORGE_MODE_FILE="$MODE_FILE" run_hook "$cmd"
}

expect_allow_as() {
  local mode="$1" cmd="$2" rc=0
  run_hook_as "$mode" "$cmd" || rc=$?
  if [ "$rc" -eq 0 ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu ALLOW mode=$mode, rc=$rc): $cmd"
  fi
}

expect_block_as() {
  local mode="$1" cmd="$2" rc=0
  run_hook_as "$mode" "$cmd" || rc=$?
  if [ "$rc" -eq 2 ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu BLOCK mode=$mode, rc=$rc): $cmd"
  fi
}

# --- fail-closed : un hook qui ne peut pas lire sa commande refuse tout ---
# Sans jq, la commande lue était vide et rien ne correspondait : tout passait
# (constaté le 2026-10-17 sur une image v2 sans jq). FORGE_JQ simule un jq absent.
expect_block_raw() {
  local label="$1" input="$2" rc=0
  shift 2
  printf '%s' "$input" | env "$@" bash "$HOOK" > /dev/null 2>&1 || rc=$?
  if [ "$rc" -eq 2 ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu BLOCK, rc=$rc): $label"
  fi
}
expect_block_raw 'jq absent, commande anodine' '{"tool_input":{"command":"ls"}}' FORGE_JQ=/nonexistent/jq
expect_block_raw 'jq absent, sudo' '{"tool_input":{"command":"sudo ls"}}' FORGE_JQ=/nonexistent/jq
expect_block_raw 'entrée JSON illisible' 'not json at all'

# --- git push : seule forme autorisée = git push [-u] origin agent/* ---
expect_allow 'git push origin agent/test-project'
expect_allow 'git push -u origin agent/test-project'
expect_allow 'cd /workspace && git push -u origin agent/foo'

expect_block 'git push'
expect_block 'git push origin main'
expect_block 'git push upstream agent/test-project'
expect_block 'git push -f origin agent/test-project'
expect_block 'git push --force origin agent/test-project'
expect_block 'git push --force-with-lease origin agent/test-project'
expect_block 'git push origin agent/test-project --force'
expect_block 'git push origin --delete agent/test-project'
expect_block 'git push -d origin agent/test-project'
expect_block 'git push origin :agent/test-project'
expect_block 'git push origin main:agent/test-project'
expect_block 'git push origin agent/test-project main'
# Un push autorisé ne doit pas masquer un push interdit dans la même commande
expect_block 'git push origin agent/test-project && git push origin main'
expect_block 'git push origin main && git push origin agent/test-project'
expect_block 'git push origin agent/test-project; git push origin main'
expect_block "$(printf 'git push origin agent/foo\ngit push origin main')"
# Les options globales de git ne doivent pas contourner la politique
expect_block 'git -C /workspace push origin main'
expect_block 'git -C /workspace push --force origin agent/test-project'
expect_block 'git --git-dir=/workspace/.git push origin main'
expect_block 'git -c user.email=x@y push origin main'
expect_block 'git -C /workspace push origin agent/test-project'
# Fail-closed assumé : redirection en fin de push autorisé (tr coupe sur &)
expect_block 'git push origin agent/test-project 2>&1'
# Séparateur collé au mot-clé : ne doit pas esquiver le déclencheur
expect_block 'git push;true'
# Pas de faux positif sur un message de commit contenant "push"
expect_allow 'git commit -m "docs: explain push policy"'

# --- gh : créer/mettre à jour des PRs oui, merger/API brute/repo non ---
expect_allow 'gh pr create --base main --title "feat: x" --body "..."'
expect_allow 'gh pr view 42'
expect_allow 'gh pr list'
expect_allow 'gh auth status'

expect_block 'gh pr merge 42'
expect_block 'gh pr merge --auto --squash'
expect_block 'gh api user'
expect_block 'gh api /repos/foo/bar'
expect_block 'gh repo view'
expect_block 'gh repo delete foo/bar'
expect_block 'cd /workspace && gh pr merge 42'
# Le flag --repo intercalé ne doit pas contourner le blocage du merge
expect_block 'gh pr --repo=owner/repo merge 42'
expect_block 'gh pr --repo owner/repo merge 42'
# Pas d'alias/extension pour renommer des commandes bloquées, pas de lecture du token
expect_block 'gh alias set pm "pr merge"'
expect_block 'gh extension install owner/gh-ext'
expect_block 'gh auth token'
expect_block 'gh auth token|cat'
# Pas de faux positif sur un titre de PR contenant "merge"
expect_allow 'gh pr create --title "fix: merge conflict" --body "x"'

# --- commandes ordinaires : toujours autorisées ---
expect_allow 'git status'
expect_allow 'git commit -m "feat: x"'
expect_allow 'ls -la /workspace'

# --- git merge : seule forme autorisée = "git merge [--no-edit] origin/main" ---
expect_allow 'git merge origin/main'
expect_allow 'git merge --no-edit origin/main'
expect_block 'git merge main'
expect_block 'git merge feature-x'
expect_block 'git merge origin/agent-forge'
expect_block 'git merge -X theirs origin/main'
expect_block 'git merge origin/main && git push origin main'
expect_block 'git merge origin/main; git checkout main'

# --- régression : blocages existants toujours actifs ---
expect_block 'git checkout main'
expect_block 'git rebase main'
expect_block 'sudo apt install foo'
expect_block 'rm -rf /workspace'

# --- supervised mode: no credential exists, so every push and every gh
# subcommand is blocked, including forms autonomous mode explicitly allows ---
expect_block_as supervised 'git push origin agent/test-project'
expect_block_as supervised 'git push -u origin agent/test-project'
expect_block_as supervised 'git push origin main'
expect_block_as supervised 'gh pr create --base main --title "x" --body "y"'
expect_block_as supervised 'gh pr view 42'
expect_block_as supervised 'gh auth status'

# --- autonomous mode, explicit: unchanged from the default behavior above ---
expect_allow_as autonomous 'git push origin agent/test-project'
expect_block_as autonomous 'git push origin main'
expect_allow_as autonomous 'gh pr create --base main --title "x" --body "y"'
expect_block_as autonomous 'gh pr merge 42'

# --- ordinary commands stay allowed in supervised mode too ---
expect_allow_as supervised 'git status'
expect_allow_as supervised 'git commit -m "feat: x"'

# --- missing marker file defaults to autonomous (existing containers,
# provisioned before this feature, keep working unmodified) ---
rc=0
FORGE_MODE_FILE="$MODE_FILE.does-not-exist" run_hook 'git push origin agent/test-project' || rc=$?
if [ "$rc" -eq 0 ]; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "FAIL (attendu ALLOW, missing marker file should default to autonomous, rc=$rc)"
fi

# --- docker : défense en profondeur en plus du confinement par namespaces
# (nesting non-privilégié — voir docs/superpowers/specs/2026-07-17-agent-docker-support-design.md) ---
expect_block 'docker run --privileged ubuntu'
expect_block 'docker run -it --privileged debian bash'
expect_block 'docker run --privileged ubuntu && echo done'
expect_allow 'docker run ubuntu'
expect_allow 'docker ps -a'
expect_allow 'docker compose up -d'

expect_block 'docker run --pid=host ubuntu'
expect_block 'docker run --pid host ubuntu'
expect_block 'docker run --network=host ubuntu'
expect_block 'docker run --net=host ubuntu'
expect_allow 'docker run --network=mybridge ubuntu'
expect_allow 'git commit -m "docs: mention --network=host in README"'
expect_allow 'docker run --network=hostnet-custom ubuntu'

expect_block 'docker run -v /etc:/etc ubuntu'
expect_block 'docker run -v /home/aiuser:/data ubuntu'
expect_block 'docker run -v /:/host ubuntu'
expect_block 'docker run --mount type=bind,source=/etc,target=/etc ubuntu'
expect_allow 'docker run -v /workspace/data:/data mongo'
expect_allow 'docker run -v mongodata:/data/db mongo'
expect_allow 'docker run --mount type=bind,source=/workspace/data,target=/data mongo'
expect_allow 'docker run -v /workspace/project/etc:/data ubuntu'
expect_block 'docker run --mount type=bind,source=/,target=/host ubuntu'

# Non-docker -v/--volume usage must not be false-blocked by the bind-mount guardrail
expect_allow 'cp -v /etc/hosts /workspace/hosts.bak'
expect_allow 'grep -v /etc/passwd'
expect_allow 'rsync -v /var/log/app.log /workspace/'
expect_allow 'mv -v /home/aiuser/file /workspace/'

# Ces blocages s'appliquent identiquement dans les deux modes (aucune credential en jeu)
expect_block_as supervised 'docker run --privileged ubuntu'
expect_block_as autonomous 'docker run --privileged ubuntu'
expect_allow_as supervised 'docker compose up -d'

echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
