#!/bin/bash
# Runs on the provisioned host as the forge user, fed to `bash -s` over SSH by
# verify.yml. Proves that an unprivileged user inside a container can create
# a user namespace (the hardening role's userns sysctls), then deletes what
# it created. The only place the host tests touch Incus internals.
set -e

P="forge-host-test"
# incus reads YAML from stdin when stdin is not a terminal (`project create`,
# for one), and stdin here is this very script: give it /dev/null instead.
inc() { incus "$@" </dev/null; }
cleanup() {
  inc delete --force smoke --project "$P" >/dev/null 2>&1 || true
  for fingerprint in $(inc image list --project "$P" --format csv --columns F 2>/dev/null); do
    inc image delete "$fingerprint" --project "$P" >/dev/null 2>&1 || true
  done
  inc project delete "$P" >/dev/null 2>&1 || true
}
trap cleanup EXIT

inc project create "$P"
# A new project has its own, empty default profile: the container gets a root
# disk on the pool (--storage) and no NIC at all.
inc launch images:ubuntu/26.04 smoke --project "$P" --storage default
inc exec smoke --project "$P" -- setpriv --reuid 1000 --regid 1000 --clear-groups unshare -Ur true
echo "incus-smoke: OK"
