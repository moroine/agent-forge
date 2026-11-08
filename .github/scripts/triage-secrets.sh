#!/bin/bash
# Usage, from inside the repository (or `npm run secrets:triage -- ...`):
#   triage-secrets.sh                 the staged changes, as .githooks/pre-commit
#                                     scans them
#   triage-secrets.sh <base> <head>   the commits <base>..<head>, as CI scans them
#                                     (.github/scripts/scan-secrets.sh)
# For each finding not already in .betterleaksignore, prints the flagged lines
# and asks why they are not a secret. A reason appends "# <reason>" and the
# finding's fingerprint to .betterleaksignore; an empty answer keeps the
# finding. Exits 0 when no finding is left, 1 when some are kept.
#
# The flagged lines are printed in clear, without control characters (a line
# from an agent's branch could otherwise drive the terminal, OSC 52 writing
# the clipboard for instance). Run it in your own terminal, never through an
# agent: a real secret would end up in its transcript.
set -e

# Fingerprints are <path>:<rule>:<line> (staged) and <commit>:<path>:<rule>:<line>
# (commits) in 1.x; 2.x hashes the secret instead.
BETTERLEAKS_MAJOR=1

die() {
  echo "triage-secrets: $1" >&2
  exit 2
}

case "$#" in
  0) mode=staged ;;
  2) mode=commits base="$1" head="$2" ;;
  *)
    echo "usage: triage-secrets.sh [<base> <head>]" >&2
    exit 2
    ;;
esac

command -v betterleaks >/dev/null 2>&1 || die "betterleaks is not installed (see CONTRIBUTING.md)"
command -v jq >/dev/null 2>&1 || die "jq is not installed"
version="$(betterleaks version 2>/dev/null)" || version=""
version="${version%%$'\n'*}"
version="${version#v}"
[ "${version%%.*}" = "$BETTERLEAKS_MAJOR" ] \
  || die "betterleaks $version is not ${BETTERLEAKS_MAJOR}.x: its fingerprints would not fit .betterleaksignore"

top="$(git rev-parse --show-toplevel 2>/dev/null)" || die "run it from inside the repository"
cd "$top"
ignore="$top/.betterleaksignore"

# The same scan as the hook or CI: redacted, inline allow comments ignored.
if [ "$mode" = staged ]; then
  args=(git --pre-commit --staged)
else
  for ref in "$base" "$head"; do
    git cat-file -e "$ref^{commit}" 2>/dev/null || die "$ref is not a commit"
  done
  args=(git "--log-opts=--diff-merges=remerge $base..$head")
fi
args+=(--redact --no-banner --ignore-gitleaks-allow)
if [ -f "$ignore" ]; then
  args+=(--gitleaks-ignore-path "$ignore")
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/forge-triage.XXXXXX")"
trap 'rm -rf "$work"' EXIT
args+=(--report-format json --report-path "$work/report.json")

# No validation or analysis: they would send candidate secrets to remote
# services, so the environment switches for them are removed.
code=0
env -u BETTERLEAKS_VALIDATE -u BETTERLEAKS_ANALYZE betterleaks "${args[@]}" "$top" \
  >/dev/null 2>"$work/log" || code=$?
if [ "$code" -eq 0 ]; then
  echo "no leaks found"
  exit 0
fi
# Exit 1 is also how betterleaks reports an error: findings need a report.
if [ "$code" -ne 1 ] || ! jq -e 'type == "array" and length > 0' "$work/report.json" >/dev/null 2>&1; then
  cat "$work/log" >&2
  die "betterleaks failed (exit $code)"
fi

# What reaches the terminal from the scanned content (paths and lines) keeps
# tab and newline as its only control characters.
clean() {
  LC_ALL=C tr -d '\000-\010\013-\037\177'
}

echo "The flagged lines are shown in clear: do not paste them anywhere."

added=0
kept=0
while IFS=$'\037' read -r fp commit file start end rule <&3; do
  echo
  if [ -n "$commit" ]; then
    echo "== $rule  $file:$start  (commit ${commit:0:12})" | clean
    blob="$commit:$file"
  else
    echo "== $rule  $file:$start  (staged)" | clean
    blob=":$file"
  fi
  if git cat-file -e "$blob" 2>/dev/null; then
    # At most five lines.
    git show "$blob" | sed -n "${start},${end}p" | head -n 5 | clean
  else
    echo "(the file cannot be read at $blob)" | clean
  fi
  printf 'Why is it not a secret? (empty: keep the finding) '
  why=""
  read -r why || echo
  why="$(printf '%s' "$why" | LC_ALL=C tr -d '\000-\037\177')"
  if [ -z "$why" ]; then
    kept=$((kept + 1))
    continue
  fi
  if [ ! -s "$ignore" ]; then
    echo "# False positives only: each fingerprint follows a comment saying why (CONTRIBUTING.md)." > "$ignore"
  elif [ -n "$(tail -c 1 "$ignore")" ]; then
    echo >> "$ignore"
  fi
  printf '# %s\n%s\n' "$why" "$fp" >> "$ignore"
  added=$((added + 1))
# Fields joined by the unit separator: read collapses consecutive tabs, so the
# empty Commit of a staged finding would shift every field after it.
done 3< <(jq -r '.[] | [.Fingerprint, (.Commit // ""), .File, (.StartLine | tostring),
  ((.EndLine // .StartLine) | tostring), .RuleID] | join("\u001f")' "$work/report.json")

echo
echo "added $added to .betterleaksignore, kept $kept"
if [ "$added" -gt 0 ]; then
  echo "review the exceptions with: git diff -- .betterleaksignore"
fi
[ "$kept" -eq 0 ]
