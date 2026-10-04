import { BlockList, isIP } from 'node:net';

/** Addresses the crawler must never connect to: loopback, private, link-local, CGNAT, metadata, multicast, reserved. */
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local incl. 169.254.169.254 cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10],
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

export function isBlockedIp(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').split('%')[0]!;
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family === 6) {
    // IPv4-mapped/compatible (::ffff:10.0.0.1, ::ffff:a00:1) → judge the embedded IPv4.
    const mapped = ip.toLowerCase().match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return blocked.check(mapped[1]!, 'ipv4');
    const hexMapped = ip.toLowerCase().match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
      const n = (parseInt(hexMapped[1]!, 16) << 16) | parseInt(hexMapped[2]!, 16);
      return blocked.check([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'), 'ipv4');
    }
    if (/^::ffff:/i.test(ip)) return true;
    return blocked.check(ip, 'ipv6');
  }
  return true; // not an IP → refuse
}

const INTERNAL_HOST = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/i;

/** Hostname-level screen (before DNS). Resolved addresses are checked separately at connect time. */
export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (isIP(h)) return isBlockedIp(h);
  if (!h.includes('.')) return true; // single-label names resolve via search domains
  if (INTERNAL_HOST.test(h)) return true;
  if (h === 'metadata.google.internal') return true;
  return false;
}
