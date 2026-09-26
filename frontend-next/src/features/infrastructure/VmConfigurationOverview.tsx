import type { ReactNode } from "react";
import { Cpu, HardDrive, Network, Server } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { QueryErrorState } from "@/components/ui/query-error-state";
import { guestOsLabel, bootOrderLabel } from "@/features/infrastructure/vm-display";

export interface VmConfiguration {
  guest_type?: "qemu" | "lxc";
  hardware?: {
    sockets?: number;
    cores?: number;
    memory_mb?: number;
    os_type?: string | null;
    bios?: string | null;
    machine?: string | null;
    scsi_controller?: string | null;
    agent_enabled?: boolean | null;
    boot_order?: string | null;
  };
  container?: { architecture?: string | null; unprivileged?: boolean | null; swap_mb?: number | null; cpu_limit?: number | null };
  disks?: Array<{
    bus: string;
    storage: string;
    size?: string | null;
    format?: string | null;
    discard?: boolean;
  }>;
  networks?: Array<{
    interface: string;
    model: string;
    bridge?: string | null;
    vlan_id?: string | null;
    mac_address?: string | null;
    firewall?: boolean;
  }>;
  guest?: {
    username?: string | null;
    ip_config?: Array<{
      interface: string;
      ipv4?: string | null;
      gateway?: string | null;
    }>;
  };
}

export function VmConfigurationOverview({
  configuration,
  guestType,
  loading,
  error,
  onRetry,
  unavailable,
}: {
  configuration?: VmConfiguration;
  guestType?: "qemu" | "lxc";
  loading: boolean;
  error?: unknown;
  onRetry: () => void;
  unavailable: boolean;
}) {
  const isContainer = (guestType ?? configuration?.guest_type) === "lxc";
  const resourceLabel = isContainer ? "Container" : "Virtual machine";
  if (unavailable)
    return (
      <Card>
        <CardHeader className="border-b py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="h-4 w-4" />
            Hardware & network
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 text-sm text-muted-foreground">
          This inventory resource has no direct platform connection configured.
        </CardContent>
      </Card>
    );
  if (loading)
    return (
      <Card>
        <CardContent className="space-y-2 p-4">
          <div className="h-4 w-40 animate-pulse rounded bg-muted" />
          <div className="h-16 animate-pulse rounded bg-muted" />
        </CardContent>
      </Card>
    );
  if (error)
    return (
      <Card>
        <CardHeader className="border-b py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="h-4 w-4" />
            Hardware & network
          </CardTitle>
        </CardHeader>
        <QueryErrorState
          compact
          error={error}
          title={`${resourceLabel} configuration could not be loaded`}
          onRetry={onRetry}
        />
      </Card>
    );
  const hardware = configuration?.hardware;
  const disks = configuration?.disks || [];
  const networks = configuration?.networks || [];
  const ips = configuration?.guest?.ip_config || [];
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(23rem,.85fr)]">
      <Card>
        <CardHeader className="border-b py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Cpu className="h-4 w-4" />
            {isContainer ? "Container configuration" : "Hardware & virtual machine"}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <dl className="console-properties">
            <VmProperty
              label="CPU"
              value={
                hardware?.cores
                  ? isContainer ? `${hardware.cores} cores` : `${hardware.sockets || 1} socket · ${hardware.cores} cores`
                  : "—"
              }
            />
            <VmProperty
              label="Memory"
              value={
                hardware?.memory_mb
                  ? `${hardware.memory_mb.toLocaleString("en-US")} MB`
                  : "—"
              }
              mono
            />
            <VmProperty
              label="Operating system"
              value={guestOsLabel(hardware?.os_type)}
              mono
            />
            {isContainer ? <>
              <VmProperty label="Architecture" value={configuration?.container?.architecture || "Not reported"} />
              <VmProperty label="Privilege mode" value={configuration?.container?.unprivileged == null ? "Not reported" : configuration.container.unprivileged ? "Unprivileged" : "Privileged"} />
              <VmProperty label="Swap limit" value={configuration?.container?.swap_mb == null ? "Not reported" : `${configuration.container.swap_mb.toLocaleString("en-US")} MB`} />
              <VmProperty label="CPU limit" value={configuration?.container?.cpu_limit == null ? "Not reported" : configuration.container.cpu_limit === 0 ? "No CPU time limit" : `${configuration.container.cpu_limit} CPU cores`} />
            </> : <>
            <VmProperty
              label="QEMU agent configuration"
              value={
                hardware?.agent_enabled == null
                  ? 'Not applicable or configuration unavailable'
                  : hardware.agent_enabled
                    ? 'Enabled in Proxmox · guest reachability not checked'
                    : 'Disabled in Proxmox'
              }
            />
            <VmProperty
              label="BIOS / machine"
              value={
                hardware
                  ? [hardware.bios, hardware.machine]
                      .filter(Boolean)
                      .join(" · ") || "Proxmox default"
                  : "—"
              }
              mono
            />
            <VmProperty
              label="Boot order"
              value={bootOrderLabel(hardware?.boot_order)}
              mono
            />
            <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Raw Proxmox configuration values</summary><p className="mt-2 break-all font-mono">OS: {hardware?.os_type || '—'} · Boot: {hardware?.boot_order || 'default'}</p></details>
            <VmProperty
              label="Cloud-Init user"
              value={configuration?.guest?.username || "Not set"}
              mono
            />
            </>}
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="border-b py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <HardDrive className="h-4 w-4" />
            {isContainer ? "Root filesystem & mount points" : "Virtual disks"}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {disks.length ? (
            <div className="divide-y">
              {disks.map((disk) => (
                <div
                  key={disk.bus}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5"
                >
                  <span className="w-12 font-mono text-xs font-medium">
                    {disk.bus}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {disk.storage}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {disk.size || "—"}
                  </span>
                  {disk.discard ? (
                    <span className="text-xs text-muted-foreground">TRIM</span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="p-4 text-sm text-muted-foreground">
              {isContainer ? "No root filesystem or mount points reported." : "No virtual disks reported."}
            </div>
          )}
        </CardContent>
      </Card>
      <Card className="xl:col-span-2">
        <CardHeader className="border-b py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Network className="h-4 w-4" />
            Network
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {networks.length ? (
            <div className="divide-y">
              {networks.map((network) => {
                const ip = ips.find(
                  (item) => item.interface === network.interface,
                );
                return (
                  <div
                    key={network.interface}
                    className="grid gap-x-4 gap-y-1 px-4 py-2.5 sm:grid-cols-[5rem_minmax(8rem,1fr)_minmax(10rem,1fr)_minmax(12rem,1fr)] sm:items-center"
                  >
                    <span className="font-mono text-xs font-medium">
                      {network.interface}
                    </span>
                    <span className="text-sm">
                      {network.bridge || "No bridge"}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {network.vlan_id
                        ? `VLAN ${network.vlan_id}`
                        : "No VLAN"}{" "}
                      · {network.model}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {ip?.ipv4 || "DHCP / not configured"}
                      {ip?.gateway ? ` · GW ${ip.gateway}` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="p-4 text-sm text-muted-foreground">
              No network interfaces reported.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function VmProperty({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="console-property console-property-wrap">
      <dt>{label}</dt>
      <dd className={mono ? "font-mono text-xs" : ""}>{value}</dd>
    </div>
  );
}
