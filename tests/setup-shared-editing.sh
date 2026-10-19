#!/usr/bin/env bash
#
# setup.sh SHARED_EDITING plumbing test: no network, no Docker
# ─────────────────────────────────────────────────────────────
# SHARED_EDITING has to travel mdnest.conf -> setup.sh -> .env -> the backend,
# which treats anything but an explicit "false" as on. A value that never
# reaches .env does not fail: it silently stays on (or off). So this pins the
# off switch, the default, a typo, and that a shell export cannot leak in.
#
# Usage:  tests/setup-shared-editing.sh
# Exit:   0 if every check passes, 1 otherwise.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASS=0; FAIL=0
green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
ok()  { PASS=$((PASS+1)); printf '  %s %s\n' "$(green PASS)" "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  %s %s\n' "$(red FAIL)" "$1"; printf '    %s\n' "$2"; }

generate() {
  local sandbox
  sandbox="$(mktemp -d)"
  cp "$REPO_ROOT/setup.sh" "$REPO_ROOT/mdnest.conf.sample" "$sandbox"/
  {
    printf 'MOUNT_test=%s/notes\n' "$sandbox"
    printf '%s\n' "$@"
  } > "$sandbox/mdnest.conf"
  ( cd "$sandbox" && bash setup.sh ) >"$sandbox/setup.out" 2>&1
  echo $? > "$sandbox/setup.rc"
  printf '%s' "$sandbox"
}
line() { grep '^SHARED_EDITING=' "$1/.env" 2>/dev/null || echo '<no SHARED_EDITING line>'; }

echo "── setup.sh: SHARED_EDITING ──"

sb="$(generate 'ENABLE_LIVE_COLLAB=true' 'SHARED_EDITING=false')"
if grep -qx 'SHARED_EDITING=false' "$sb/.env" 2>/dev/null; then ok "SHARED_EDITING=false reaches .env"
else bad "SHARED_EDITING=false reaches .env" "got: $(line "$sb")"; fi
rm -rf "$sb"

sb="$(generate 'ENABLE_LIVE_COLLAB=true')"
if grep -qx 'SHARED_EDITING=true' "$sb/.env" 2>/dev/null; then ok "unset SHARED_EDITING is written as true"
else bad "unset SHARED_EDITING is written as true" "got: $(line "$sb")"; fi
rm -rf "$sb"

sb="$(generate 'SHARED_EDITING=flase')"
if [ "$(cat "$sb/setup.rc")" != 0 ] && grep -q 'SHARED_EDITING must be true or false' "$sb/setup.out"; then
  ok "a typo is refused at setup instead of silently meaning on"
else
  bad "a typo is refused at setup instead of silently meaning on" "rc=$(cat "$sb/setup.rc"), $(tail -2 "$sb/setup.out")"
fi
rm -rf "$sb"

sb="$(SHARED_EDITING=false generate 'ENABLE_LIVE_COLLAB=true')"
if grep -qx 'SHARED_EDITING=true' "$sb/.env" 2>/dev/null; then ok "a value exported in the shell does not leak in"
else bad "a value exported in the shell does not leak in" "got: $(line "$sb")"; fi
rm -rf "$sb"

if grep -q 'SHARED_EDITING' "$REPO_ROOT/mdnest.conf.sample"; then ok "SHARED_EDITING is documented in mdnest.conf.sample"
else bad "SHARED_EDITING is documented in mdnest.conf.sample" "no mention in the sample conf"; fi

echo ""
printf 'setup-shared-editing: %s passed, %s failed\n' "$(green "$PASS")" "$([ "$FAIL" -eq 0 ] && green 0 || red "$FAIL")"
[ "$FAIL" -eq 0 ]
