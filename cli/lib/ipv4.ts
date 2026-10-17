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
