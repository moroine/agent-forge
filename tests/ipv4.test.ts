import { test } from "node:test";
import assert from "node:assert/strict";
import { addressIn, cidrWithin, isHostAddress, parseAddress, parseCidr, REJECTED_RANGES } from "../cli/lib/ipv4.ts";

const cidr = (text: string) => parseCidr(text)!;

test("parseCidr reads an address and its prefix", () => {
  assert.deepEqual(parseCidr("10.77.0.1/24"), { address: 10 * 2 ** 24 + 77 * 2 ** 16 + 1, prefix: 24 });
  assert.deepEqual(parseCidr("255.255.255.255/32"), { address: 2 ** 32 - 1, prefix: 32 });
});

test("parseCidr refuses malformed input", () => {
  for (const bad of ["10.77.0.1", "10.77.0/24", "10.77.0.256/24", "10.77.0.1/33", "010.1.1.1/8", "a.b.c.d/8", "10.77.0.1/24/1", ""]) {
    assert.equal(parseCidr(bad), null, bad);
  }
});

test("cidrWithin needs the whole subnet inside the range", () => {
  assert.equal(cidrWithin(cidr("10.77.0.1/24"), cidr("10.0.0.0/8")), true);
  assert.equal(cidrWithin(cidr("10.0.0.1/7"), cidr("10.0.0.0/8")), false);
  assert.equal(cidrWithin(cidr("172.32.0.1/24"), cidr("172.16.0.0/12")), false);
  assert.equal(cidrWithin(cidr("192.168.200.1/24"), cidr("192.168.0.0/16")), true);
});

test("addressIn matches the ACL's ranges, edges included", () => {
  assert.equal(addressIn(parseAddress("169.254.169.254")!, "169.254.0.0/16"), true);
  assert.equal(addressIn(parseAddress("100.127.255.255")!, "100.64.0.0/10"), true);
  assert.equal(addressIn(parseAddress("100.128.0.0")!, "100.64.0.0/10"), false);
  assert.equal(addressIn(parseAddress("239.255.255.250")!, "224.0.0.0/4"), true);
  assert.equal(addressIn(parseAddress("8.8.8.8")!, "10.0.0.0/8"), false);
});

test("the network and broadcast addresses are not host addresses", () => {
  assert.equal(isHostAddress(cidr("10.77.0.0/24")), false);
  assert.equal(isHostAddress(cidr("10.77.0.255/24")), false);
  assert.equal(isHostAddress(cidr("10.77.0.1/24")), true);
});

test("the ACL's ranges, in order", () => {
  assert.deepEqual([...REJECTED_RANGES], [
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10", "224.0.0.0/4",
  ]);
});
