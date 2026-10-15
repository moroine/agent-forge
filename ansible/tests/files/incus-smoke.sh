#!/bin/bash
# Runs on the provisioned host as the forge user, fed to `bash -s` over SSH by
# verify.yml. Proves that an unprivileged user inside a container can create
# a user namespace (the hardening role's userns sysctls), then deletes what
# it created. The only place the host tests touch Incus internals.
set -e

P="forge-host-test"
cleanup() {
  incus delete --force smoke --project "$P" >/dev/null 2>&1 || true
  for fingerprint in $(incus image list --project "$P" --format csv --columns F 2>/dev/null); do
    incus image delete "$fingerprint" --project "$P" >/dev/null 2>&1 || true
  done
  incus project delete "$P" >/dev/null 2>&1 || true
}
trap cleanup EXIT

incus project create "$P"
# A new project has its own, empty default profile: the container gets a root
# disk on the pool (--storage) and no NIC at all.
incus launch images:ubuntu/26.04 smoke --project "$P" --storage default
incus exec smoke --project "$P" -- setpriv --reuid 1000 --regid 1000 --clear-groups unshare -Ur true
echo "incus-smoke: OK"
