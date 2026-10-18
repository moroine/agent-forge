// IPv4 helpers for the bridge address and the ACL's rejected ranges: plain
// 32-bit arithmetic, no dependency. Addresses are unsigned numbers.

export type Cidr = { address: number; prefix: number };

// The ranges ACL forge-egress rejects, in the ACL's destination order (spec
// "forge setup → Objects").
export const REJECTED_RANGES = [
  "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
  "169.254.0.0/16", "100.64.0.0/10", "224.0.0.0/4",
] as const;

// The bridge must lie in one of these, so that the ACL also rejects traffic to
// the bridge address itself.
export const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] as const;

export function parseAddress(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    // No leading zero: "010" is octal to some parsers and decimal to others.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value;
}

export function parseCidr(text: string): Cidr | null {
  const match = /^([0-9.]+)\/([0-9]{1,2})$/.exec(text);
  if (!match) return null;
  const address = parseAddress(match[1]);
  const prefix = Number(match[2]);
  if (address === null || prefix > 32) return null;
  return { address, prefix };
}

function mask(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

export function network(c: Cidr): number {
  return (c.address & mask(c.prefix)) >>> 0;
}

// True when every address of `inner` lies in `outer`.
export function cidrWithin(inner: Cidr, outer: Cidr): boolean {
  return inner.prefix >= outer.prefix && network({ address: inner.address, prefix: outer.prefix }) === network(outer);
}

export function addressIn(address: number, range: string): boolean {
  const r = parseCidr(range);
  if (!r) throw new Error(`invalid range ${range}`);
  return network({ address, prefix: r.prefix }) === network(r);
}

// Neither the subnet's network address nor its broadcast address.
export function isHostAddress(c: Cidr): boolean {
  const first = network(c);
  const last = first + 2 ** (32 - c.prefix) - 1;
  return c.address !== first && c.address !== last;
}

export function formatAddress(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

export type ProxyPlan = { bridgeAddress: string; subnet: string; proxyAddress: string; dhcpRanges: string };

// The proxy block: network+2 … network+9, eight addresses kept out of DHCP.
const RESERVED_FIRST = 2;
const RESERVED_LAST = 9;

// DHCP hands out network+10 … broadcast-1 ("<first>-<last>"). A /27 keeps 21.
export function dhcpRanges(bridgeCidr: string): string {
  const c = parseCidr(bridgeCidr);
  if (!c) throw new Error(`invalid CIDR ${bridgeCidr}`);
  const first = network(c);
  const broadcast = first + 2 ** (32 - c.prefix) - 1;
  return `${formatAddress(first + RESERVED_LAST + 1)}-${formatAddress(broadcast - 1)}`;
}

// Where the proxy of `slot` lives. Slot n is the n-th reserved address; the
// bridge's own address is skipped if it falls inside the block. A slot beyond
// the block is a programming error, not a user error.
export function proxyPlan(bridgeCidr: string, slot: number): ProxyPlan {
  const c = parseCidr(bridgeCidr);
  if (!c) throw new Error(`invalid CIDR ${bridgeCidr}`);
  const first = network(c);
  const reserved: number[] = [];
  for (let a = first + RESERVED_FIRST; a <= first + RESERVED_LAST; a++) {
    if (a !== c.address) reserved.push(a);
  }
  const proxy = reserved[slot];
  if (!Number.isInteger(slot) || slot < 0 || proxy === undefined) {
    throw new Error(`proxy slot ${slot} is outside the reserved block`);
  }
  return {
    bridgeAddress: formatAddress(c.address),
    subnet: `${formatAddress(first)}/${c.prefix}`,
    proxyAddress: formatAddress(proxy),
    dhcpRanges: dhcpRanges(bridgeCidr),
  };
}
