#!/bin/bash
set -e

# Ce script reste en bash (voir la spec, Non-goals) mais n'est plus sourcé par
# un dispatcher bash : il s'exécute seul, appelé par commands/image.ts.
# FORGE_REPO_DIR était sa seule dépendance à forge-common.sh.
FORGE_REPO_DIR="${FORGE_REPO_DIR:-/home/moroine/agent-forge}"

# forge image build (alias: forge image update)
# Scripts the manual agent-base build sequence from README §5.
# Only affects containers created after the rebuild — already-running
# containers are not patched in place.

cmd_forge_image() {
  case "${1:-}" in
    build|update)
      case "${2:-}" in
        "") _forge_image_build ;;
        super) _forge_image_build_super ;;
        *) echo "Usage: forge image build|update [super]" >&2; return 1 ;;
      esac
      ;;
    *)
      echo "Usage: forge image build|update [super]" >&2
      return 1
      ;;
  esac
}

_forge_image_build() {
  local setup="agent-base-setup"

  if lxc info "$setup" > /dev/null 2>&1; then
    echo "Removing leftover $setup container from a previous failed build..."
    lxc delete "$setup" --force
  fi

  echo "Launching scratch container $setup..."
  # Profil "agent" (pas le défaut) : il faut security.nesting pour que
  # dockerd-rootless-setuptool.sh puisse réellement démarrer le daemon
  # pendant le build, pas seulement installer les fichiers/units — sans
  # nesting, le démarrage du service échoue ("control process exited with
  # error code", confirmé en conditions réelles).
  lxc launch ubuntu:24.04 "$setup" --profile agent

  lxc exec "$setup" -- apt update
  lxc exec "$setup" -- apt install -y git git-lfs tmux curl wget unzip zip python3 python3-pip
  lxc exec "$setup" -- bash -c "curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -"
  lxc exec "$setup" -- apt install -y nodejs
  lxc exec "$setup" -- npm install -g pnpm
  # claude-code n'est plus installé dans l'image : il est monté en lecture
  # seule depuis l'hôte (device forge-claude). Le shim résout la version UNE
  # fois, au lancement, puis exec le chemin versionné absolu — un `forge claude
  # update` pendant une session ne peut donc pas retirer un module sous les
  # pieds d'un process déjà démarré.
  lxc exec "$setup" -- bash -c 'cat > /usr/local/bin/claude <<"SHIM"
#!/bin/sh
set -e
# Repertoire parametrable UNIQUEMENT pour les tests, qui executent ce shim
# sur une arborescence jetable : sans cela la seule verification possible
# reste un grep du texte, et un lien `current` casse repart en production.
# En container, toujours le montage read-only /opt/forge-claude.
# (Pas de guillemet simple ici : ce heredoc vit dans un bash -c quote.)
D=${FORGE_CLAUDE_DIR:-/opt/forge-claude}
if [ ! -e "$D/current" ]; then
  echo "claude-code is not installed on the host. Run: forge claude update" >&2
  exit 1
fi
V=$(readlink -f "$D/current")
exec "$V/node_modules/.bin/claude" "$@"
SHIM
chmod 755 /usr/local/bin/claude'
  lxc exec "$setup" -- bash -c 'mkdir -p -m 755 /etc/apt/keyrings && wget -qO /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg'
  lxc exec "$setup" -- bash -c 'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list'
  lxc exec "$setup" -- bash -c 'apt update && apt install -y gh'
  lxc exec "$setup" -- bash -c "wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/chrome.deb && apt install -y --fix-missing /tmp/chrome.deb"
  echo "Installing chrome-devtools-mcp..."
  lxc exec "$setup" -- npm install -g chrome-devtools-mcp@latest
  echo "Installing Docker (rootless)..."
  lxc exec "$setup" -- apt install -y uidmap dbus-user-session
  lxc exec "$setup" -- bash -c 'mkdir -p -m 755 /etc/apt/keyrings && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && chmod a+r /etc/apt/keyrings/docker.asc'
  lxc exec "$setup" -- bash -c 'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list'
  # docker-ce-rootless-extras ne fournit que les scripts wrapper
  # (dockerd-rootless.sh, dockerd-rootless-setuptool.sh) — pas le binaire
  # dockerd/containerd lui-même, qui vit uniquement dans docker-ce/
  # containerd.io. Sans eux, dockerd-rootless.sh échoue à "exec dockerd"
  # avec "not found" (confirmé en conditions réelles). On les installe donc
  # aussi, puis on désactive ET masque immédiatement leurs units rootful —
  # dockerd/containerd tournant en root ne doit jamais être actif, seul le
  # binaire nous intéresse. L'auto-start du postinst apt est sans
  # conséquence : ce conteneur scratch est jeté après publication de
  # l'image, seul l'état filesystem (post-stop) est capturé.
  lxc exec "$setup" -- bash -c 'apt update && apt install -y docker-ce docker-ce-cli containerd.io docker-ce-rootless-extras docker-compose-plugin'
  lxc exec "$setup" -- systemctl disable --now docker.service docker.socket containerd.service
  lxc exec "$setup" -- systemctl mask docker.service containerd.service
  lxc exec "$setup" -- useradd -m -s /bin/bash aiuser
  lxc exec "$setup" -- bash -c "mkdir -p /workspace /home/aiuser/.ssh /home/aiuser/.claude /home/aiuser/.local/bin && chown aiuser:aiuser /workspace /home/aiuser/.ssh /home/aiuser/.claude /home/aiuser/.local/bin && chmod 750 /workspace && chmod 700 /home/aiuser/.ssh"
  # useradd -m ne corrige ni l'ownership ni le contenu (skel) d'un
  # /home/aiuser préexistant — seulement d'un répertoire qu'il vient de
  # créer (confirmé en conditions réelles : $HOME=/home/aiuser force par
  # environment.HOME du profil sur TOUS les lxc exec, y compris les étapes
  # apt/npm en root avant useradd, donc /home/aiuser existe presque
  # toujours déjà, root:root, avant même useradd). Le chown -R final,
  # après la création de .ssh/.claude/.local/bin ci-dessus, corrige tout
  # l'arbre en une seule passe — y compris /home/aiuser/.local lui-même,
  # créé root:root en effet de bord du mkdir -p précédent (qui ne chown
  # que .local/bin, pas son parent .local). Sans ce chown final sur tout
  # l'arbre, dockerd échoue plus loin avec "mkdir
  # /home/aiuser/.local/share: permission denied" (confirmé en conditions
  # réelles).
  lxc exec "$setup" -- chown -R aiuser:aiuser /home/aiuser
  echo "Configuring rootless Docker for aiuser..."
  # useradd -m auto-assigns a subuid/subgid range on Ubuntu 24.04 (via
  # shadow-utils, tied to the user's own UID) ; on remplace cette entrée par
  # une plage connue plutôt que d'en ADDitionner une seconde, sinon les deux
  # plages se chevauchent et newuidmap rejette l'écriture dans uid_map
  # (EINVAL) au moment du setup rootless ci-dessous.
  lxc exec "$setup" -- bash -c "sed -i '/^aiuser:/d' /etc/subuid /etc/subgid"
  lxc exec "$setup" -- bash -c "echo 'aiuser:200000:65536' >> /etc/subuid"
  lxc exec "$setup" -- bash -c "echo 'aiuser:200000:65536' >> /etc/subgid"
  lxc exec "$setup" -- loginctl enable-linger aiuser
  lxc exec "$setup" -- su - aiuser -c "dockerd-rootless-setuptool.sh install --skip-iptables"
  lxc exec "$setup" -- su - aiuser -c "systemctl --user enable docker"
  lxc exec "$setup" -- su - aiuser -c "echo 'export DOCKER_HOST=unix:///run/user/1001/docker.sock' >> /home/aiuser/.bashrc"
  lxc exec "$setup" -- su - aiuser -c "echo 'export PATH=/usr/bin:\$PATH' >> /home/aiuser/.bashrc"

  lxc stop "$setup"
  lxc image delete agent-base 2>/dev/null || true
  lxc publish "$setup" --alias agent-base
  lxc delete "$setup"

  # Stamp the build commit so `forge list` can flag containers running on an
  # older image than the latest build.
  local build_commit
  build_commit=$(git -C "$FORGE_REPO_DIR" rev-parse HEAD)
  lxc image set-property agent-base user.forge.commit "$build_commit"

  echo "Image agent-base published (build $build_commit)."
}

_forge_image_build_super() {
  local setup="agent-super-setup"

  # agent-base-super se construit EN COUCHE par-dessus agent-base : on le bâtit
  # d'abord s'il manque, plutôt que d'échouer.
  if ! lxc image info agent-base > /dev/null 2>&1; then
    echo "agent-base image missing; building it first..."
    _forge_image_build
  fi

  if lxc info "$setup" > /dev/null 2>&1; then
    echo "Removing leftover $setup container from a previous failed build..."
    lxc delete "$setup" --force
  fi

  echo "Launching scratch container $setup from agent-base (profile agent-super)..."
  # Le profil agent-super garde mac_admin/mac_override/sys_ptrace : sans elles,
  # snap-confine ne peut pas charger ses profils AppArmor et `snap install lxd`
  # échoue (prouvé par le spike du 2026-09-17).
  lxc launch agent-base "$setup" --profile agent-super

  # snapd est présent dans agent-base mais ni démarré ni seedé : on le démarre
  # et on attend le seed avant d'installer le snap LXD.
  echo "Starting snapd and installing nested LXD..."
  lxc exec "$setup" -- systemctl start snapd.socket snapd.service
  lxc exec "$setup" -- snap wait system seed.loaded
  lxc exec "$setup" -- snap install lxd
  # aiuser pilote le socket LXD interne sans sudo.
  lxc exec "$setup" -- usermod -aG lxd aiuser

  lxc stop "$setup"
  lxc image delete agent-base-super 2>/dev/null || true
  lxc publish "$setup" --alias agent-base-super
  lxc delete "$setup"

  # Même tampon que agent-base : `forge list` compare le container à ce commit.
  local build_commit
  build_commit=$(git -C "$FORGE_REPO_DIR" rev-parse HEAD)
  lxc image set-property agent-base-super user.forge.commit "$build_commit"

  echo "Image agent-base-super published (build $build_commit)."
}

# Exécutable ET sourçable en sécurité : l'ancien scripts/forge source ce
# fichier avant tout dispatch (set -e en tête), donc un appel inconditionnel
# ici tuait tout le processus sur les arguments du script appelant. Ce garde
# standard ne se déclenche que quand le fichier est exécuté directement
# (comme le fait commands/image.ts via `bash <path> <sub>`), pas quand il
# est sourcé.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  cmd_forge_image "$@"
fi
