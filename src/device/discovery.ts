import {
  CipherKey,
  Client,
  broadcastAddress,
  getLocalIPv4Interfaces,
  type CLUDevice,
} from "opengr8on-node/client";
import { english, type Tr } from "../i18n";

export type LocalInterface = ReturnType<typeof getLocalIPv4Interfaces>[number];

/**
 * Picks the local interface for discovery. `setting` is the `opengr8on.network.interface` value:
 * an interface name or IPv4 address; empty = the first non-internal IPv4 interface.
 */
export function pickInterface(setting: string, interfaces: LocalInterface[] = getLocalIPv4Interfaces()): LocalInterface {
  const wanted = setting.trim();
  const found = wanted ? interfaces.find((i) => i.name === wanted || i.address === wanted) : interfaces[0];
  if (!found) {
    const known = interfaces.map((i) => `${i.name} (${i.address})`).join(", ") || "none";
    throw new Error(wanted ? `network interface "${wanted}" not found; available: ${known}` : "no IPv4 network interface found");
  }
  return found;
}

/** Netmask -> CIDR prefix length (`255.255.255.0` -> 24). */
export function prefixLength(netmask: string): number {
  return netmask
    .split(".")
    .map(Number)
    .reduce((n, octet) => n + (octet >>> 0).toString(2).replace(/0/g, "").length, 0);
}

export interface InterfaceChoice {
  label: string;
  description: string;
  detail?: string;
  /** Value written to `opengr8on.network.interface` ("" = automatic). */
  value: string;
  picked: boolean;
}

/**
 * Quick pick entries for `opengr8on.network.interface`: "Automatic" first, then every interface.
 * The stored value is the interface name (stable across DHCP renewals) unless the name carries
 * several IPv4 addresses, then the address. `current` marks the configured entry as picked.
 */
export function interfaceChoices(current: string, interfaces: LocalInterface[] = getLocalIPv4Interfaces(), tr: Tr = english): InterfaceChoice[] {
  const wanted = current.trim();
  const auto = interfaces[0];
  const choices: InterfaceChoice[] = [
    {
      label: tr("Automatic"),
      description: auto ? tr("first interface: {0} ({1})", auto.name, auto.address) : tr("no IPv4 interface found"),
      value: "",
      picked: wanted === "",
    },
  ];
  for (const i of interfaces) {
    const shared = interfaces.filter((o) => o.name === i.name).length > 1;
    const value = shared ? i.address : i.name;
    choices.push({
      label: i.name,
      description: `${i.address}/${prefixLength(i.netmask)}`,
      detail: `${tr("broadcast {0}", broadcastAddress(i.address, i.netmask))}${i.mac ? `, MAC ${i.mac}` : ""}`,
      value,
      picked: wanted !== "" && (wanted === i.address || (!shared && wanted === i.name)),
    });
  }
  return choices;
}

export interface DiscoverOptions {
  iface: LocalInterface;
  /** Project key: CLUs already adopted with it are reported with cipherType PROJECT. Default: random. */
  projectKey?: CipherKey;
  /** Per-CLU private keys (serial -> key), as in OM / keys.json. */
  privateKeys?: Record<number, Buffer>;
  timeoutMs?: number;
}

/** Broadcasts a discovery request on the subnet of `iface` and collects CLU replies. */
export async function discoverClus(opts: DiscoverOptions): Promise<CLUDevice[]> {
  const client = new Client(opts.iface.address, broadcastAddress(opts.iface.address, opts.iface.netmask));
  try {
    return await client.discover(opts.projectKey ?? CipherKey.random(), opts.privateKeys ?? {}, opts.timeoutMs ?? 4000);
  } finally {
    client.close();
  }
}
