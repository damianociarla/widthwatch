import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

const blockedHosts = new Set(["localhost", "metadata.google.internal", "instance-data.ec2.internal", "169.254.169.254", "fd00:ec2::254"]);
const blockedSuffixes = [".localhost", ".local", ".internal", ".home.arpa"];

export class UnsafeUrlError extends Error {
  constructor(message = "The URL does not resolve to a public internet address.") { super(message); this.name = "UnsafeUrlError"; }
}

export async function resolvePublicTarget(value: string): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try { url = new URL(value); } catch { throw new UnsafeUrlError("Enter a valid website URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) throw new UnsafeUrlError();
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!hostname || blockedHosts.has(hostname) || blockedSuffixes.some((suffix) => hostname.endsWith(suffix))) throw new UnsafeUrlError();
  const addresses = ipaddr.isValid(hostname) ? [hostname] : await lookup(hostname, { all: true, verbatim: true }).then((items) => items.map((item) => item.address), () => []);
  if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) throw new UnsafeUrlError();
  return { url, addresses };
}

export async function assertPublicUrl(value: string): Promise<URL> {
  const normalized = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return (await resolvePublicTarget(normalized)).url;
}

export function isPublicAddress(value: string): boolean {
  try {
    let address = ipaddr.parse(value);
    if (address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress()) address = address.toIPv4Address();
    return address.range() === "unicast";
  } catch { return false; }
}

