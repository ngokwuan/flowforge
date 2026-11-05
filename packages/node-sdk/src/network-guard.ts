import { lookup as dnsLookup } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';

export class BlockedAddressError extends Error {
  constructor(address: string) {
    super(`Blocked destination ${address}: private or reserved network`);
    this.name = 'BlockedAddressError';
  }
}

function parseIPv4(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number(part) : NaN,
  );
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function parseIPv6(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);

  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two hextets.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    text =
      text.slice(0, lastColon + 1) +
      ((v4[0] << 8) | v4[1]).toString(16) +
      ':' +
      ((v4[2] << 8) | v4[3]).toString(16);
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];

  let groups: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...rest];
  }

  const values = groups.map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN,
  );
  return values.length === 8 && values.every((value) => !Number.isNaN(value))
    ? values
    : null;
}

function isBlockedIPv4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this" network
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, includes cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol, TEST-NET-1
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

const v4FromHextets = (high: number, low: number) => [
  high >> 8,
  high & 0xff,
  low >> 8,
  low & 0xff,
];

function isBlockedIPv6(h: number[]): boolean {
  const zeros = (from: number, to: number) =>
    h.slice(from, to).every((x) => x === 0);

  if (zeros(0, 7) && (h[7] === 0 || h[7] === 1)) return true; // :: and ::1
  if (zeros(0, 5) && h[5] === 0xffff)
    return isBlockedIPv4(v4FromHextets(h[6], h[7])); // IPv4-mapped
  if (zeros(0, 6)) return isBlockedIPv4(v4FromHextets(h[6], h[7])); // IPv4-compatible
  if (h[0] === 0x64 && h[1] === 0xff9b && zeros(2, 6)) {
    return isBlockedIPv4(v4FromHextets(h[6], h[7])); // NAT64
  }
  if (h[0] === 0x2002) return isBlockedIPv4(v4FromHextets(h[1], h[2])); // 6to4
  if (h[0] === 0x2001 && h[1] === 0) return true; // Teredo
  if (h[0] === 0x2001 && h[1] === 0xdb8) return true; // documentation
  if (h[0] === 0x100 && zeros(1, 4)) return true; // discard-only
  return (
    (h[0] & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (h[0] & 0xffc0) === 0xfe80 || // link-local
    (h[0] & 0xffc0) === 0xfec0 || // deprecated site-local
    (h[0] & 0xff00) === 0xff00 // multicast
  );
}

/** True when the address must not be reached from a user-controlled request. */
export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = parseIPv4(address);
    return octets === null || isBlockedIPv4(octets);
  }
  if (version === 6) {
    const hextets = parseIPv6(address);
    return hextets === null || isBlockedIPv6(hextets);
  }
  return true; // not an IP at all: fail closed
}

const stripBrackets = (host: string) =>
  host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

/** Static check for URLs typed into a workflow. DNS names are checked at connect time. */
export function isBlockedHostLiteral(hostname: string): boolean {
  const host = stripBrackets(hostname);
  return isIP(host) !== 0 && isBlockedAddress(host);
}

/**
 * DNS lookup for the HTTP client. It validates the addresses it is about to hand
 * to the socket, so the check and the connection use the same answer. That closes
 * the DNS-rebinding gap that exists when you resolve once to check and again to connect.
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    const done = callback as (...args: unknown[]) => void;
    if (error) return done(error);

    const blocked = addresses.find((entry) => isBlockedAddress(entry.address));
    if (blocked) return done(new BlockedAddressError(blocked.address));

    if (options.all) return done(null, addresses);
    return done(null, addresses[0].address, addresses[0].family);
  });
};
