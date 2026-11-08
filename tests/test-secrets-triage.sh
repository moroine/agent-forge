#!/bin/bash
# .github/scripts/triage-secrets.sh: only the cases that guard the ignore file
# and the maintainer's terminal. A fake betterleaks records its arguments and
# environment, and writes the report it is given.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TRIAGE="$ROOT/.github/scripts/triage-secrets.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0

mkdir -p "$TMP/bin"
cat > "$TMP/bin/betterleaks" <<'EOF'
#!/bin/bash
if [ "$1" = version ]; then echo 1.10.0; exit 0; fi
printf '%s\n' "$@" > "$FAKE_BL_ARGS"
echo "${BETTERLEAKS_VALIDATE-unset} ${BETTERLEAKS_ANALYZE-unset}" > "$FAKE_BL_ENV"
while [ "$#" -gt 0 ]; do
  if [ "$1" = --report-path ]; then cp "$FAKE_BL_REPORT" "$2"; fi
  shift
done
exit "${FAKE_BL_EXIT:-1}"
EOF
chmod 755 "$TMP/bin/betterleaks"
export FAKE_BL_ARGS="$TMP/args" FAKE_BL_ENV="$TMP/env" FAKE_BL_REPORT="$TMP/report.json"
# An empty global config: the developer's own (signing key...) never applies.
: > "$TMP/gitconfig"
export GIT_CONFIG_GLOBAL="$TMP/gitconfig" GIT_CONFIG_NOSYSTEM=1

check() {
  local what="$1"
  shift
  if "$@"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL: $what"; fi
}
has_arg() { grep -qxF -- "$1" "$FAKE_BL_ARGS"; }
lacks() { ! grep -qF -- "$1" "$2"; }
no_escape() { ! printf '%s' "$1" | LC_ALL=C grep -q "$(printf '\033')"; }

# A throwaway repository: line 2 of f.yml carries a terminal escape sequence
# (OSC 52 writes the clipboard), line 3 a second candidate.
REPO="$TMP/repo"
git init -q -b main "$REPO"
printf 'a\nurl: https://example.invalid/r \033]52;c;cHduZWQ=\a\nkey: other\n' > "$REPO/f.yml"
git -C "$REPO" add f.yml
git -C "$REPO" -c user.name=t -c user.email=t@example.invalid commit -q --no-gpg-sign -m c1
C1="$(git -C "$REPO" rev-parse HEAD)"

# report <fingerprint> <commit> <line>...: a report with one finding per triple.
report() {
  local out="[" sep=""
  while [ "$#" -gt 0 ]; do
    out="$out$sep{\"Fingerprint\":\"$1\",\"Commit\":\"$2\",\"File\":\"f.yml\",\"StartLine\":$3,\"RuleID\":\"generic-credential-uri\"}"
    sep=","
    shift 3
  done
  printf '%s]\n' "$out" > "$FAKE_BL_REPORT"
}

# run_triage <answers> [args...]: sets CODE and OUT (stdout and stderr).
run_triage() {
  local answers="$1"
  shift
  CODE=0
  OUT="$(cd "$REPO" && printf '%b' "$answers" | PATH="$TMP/bin:/usr/bin:/bin" bash "$TRIAGE" "$@" 2>&1)" || CODE=$?
}

# 1. Commits mode: a reason adds the commented fingerprint, an empty answer
# keeps the finding (and fails); the line is shown without control characters;
# the scan never validates.
FP1="$C1:f.yml:generic-credential-uri:2"
FP2="$C1:f.yml:generic-credential-uri:3"
report "$FP1" "$C1" 2 "$FP2" "$C1" 3
BETTERLEAKS_VALIDATE=true run_triage 'fake URL of a test\n\n' "$C1~0" "$C1"
check "a reason adds the comment then the fingerprint" \
  grep -qxF -- "$FP1" <(grep -A1 -xF '# fake URL of a test' "$REPO/.betterleaksignore")
check "an empty answer adds nothing" lacks "$FP2" "$REPO/.betterleaksignore"
check "a kept finding fails" [ "$CODE" -ne 0 ]
check "the line is shown" grep -qF 'url: https://example.invalid/r' <<< "$OUT"
check "control characters are stripped" no_escape "$OUT"
check "commits are scanned as in CI" has_arg "--log-opts=--diff-merges=remerge $C1~0..$C1"
check "no validation" grep -qxF "unset unset" "$FAKE_BL_ENV"

# 2. Staged mode (no arguments): the staged changes, as the hook scans them.
rm -f "$REPO/.betterleaksignore"
report "f.yml:generic-credential-uri:3" "" 3
run_triage 'not a secret\n'
check "staged changes are scanned as in the hook" has_arg "--staged"
check "the staged line is shown" grep -qxF "key: other" <<< "$OUT"
check "every finding ignored succeeds" [ "$CODE" -eq 0 ]
check "the staged fingerprint is added" grep -qxF "f.yml:generic-credential-uri:3" "$REPO/.betterleaksignore"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
