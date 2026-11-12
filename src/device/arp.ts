/**
 * MAC of a CLU we talked to, from the OS neighbour (ARP) table: every UDP exchange with a CLU on
 * the local subnet leaves its MAC there, so CLUs known only from the project (never discovered)
 * get one too. Linux only (/proc/net/arp); elsewhere null (discovery / CONFIG.JSON still fill it).
 */
import { readFile } from "node:fs/promises";
import { normalizeMac } from "./cluInfo";

/**
 * `/proc/net/arp` text → MAC of `ip`, or null (not listed, incomplete entry, flags 0x0).
 *   IP address       HW type     Flags       HW address            Mask     Device
 *   10.0.0.13        0x1         0x2         aa:bb:cc:00:11:22     *        eth0
 */
export function macFromProcArp(text: string, ip: string): string | null {
  for (const line of text.split("\n").slice(1)) {
    const [addr, , flags, hw] = line.trim().split(/\s+/);
    if (addr !== ip || !flags || (Number(flags) & 0x2) === 0) continue;
    return normalizeMac(hw);
  }
  return null;
}

export async function macFromArp(ip: string, read: () => Promise<string> = () => readFile("/proc/net/arp", "utf8")): Promise<string | null> {
  if (process.platform !== "linux") return null;
  try {
    return macFromProcArp(await read(), ip);
  } catch {
    return null;
  }
}
