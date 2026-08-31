import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, RefreshCw, Server, X } from "lucide-react";
import { api, apiFetch } from "@/lib/api";
import { showToast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface CatalogItem {
  name?: string;
  id?: string;
  vm_id?: string | number;
  online?: boolean;
  active?: boolean;
  source?: "node" | "sdn";
  type?: string;
  zone?: string;
  zone_type?: string;
  alias?: string;
  vlan_id?: number | null;
  vnet?: string;
  available_on_node?: boolean;
}
interface Catalog {
  node?: string;
  next_vm_id?: string | number;
  nodes?: CatalogItem[];
  templates?: CatalogItem[];
  datastores?: CatalogItem[];
  bridges?: CatalogItem[];
  sdn_zones?: CatalogItem[];
  sdn_vnets?: CatalogItem[];
  vlans?: CatalogItem[];
  sdn_warnings?: string[];
}
interface VmTemplate {
  id: string;
  name: string;
  config: Partial<Omit<VmForm, "dns_servers">> & {
    dns_servers?: string | string[];
    pre_deploy_target_server_id?: string;
    pre_deploy_playbooks?: string[];
    post_deploy_playbooks?: string[];
  };
}
interface Playbook {
  filename?: string;
  name?: string;
  description?: string;
}
interface Host { id: string; name: string; ip_address?: string; environment_id?: string }

interface VmForm {
  name: string;
  node_name: string;
  vm_id: string;
  clone_vm_id: string;
  clone_retries: string;
  disk_datastore: string;
  disk_interface: string;
  disk_size_gb: string;
  disk_discard: string;
  cpu_cores: string;
  cpu_type: string;
  memory_mb: string;
  agent_enabled: boolean;
  bridge: string;
  vlan_id: string;
  ipv4_mode: "dhcp" | "static";
  ipv4_address: string;
  ipv4_prefix: string;
  ipv4_gateway: string;
  dns_servers: string;
  username: string;
  ssh_public_key_variable: string;
  started: boolean;
}

const initialForm: VmForm = {
  name: "",
  node_name: "",
  vm_id: "",
  clone_vm_id: "9000",
  clone_retries: "3",
  disk_datastore: "",
  disk_interface: "scsi0",
  disk_size_gb: "40",
  disk_discard: "on",
  cpu_cores: "2",
  cpu_type: "host",
  memory_mb: "4096",
  agent_enabled: true,
  bridge: "vmbr0",
  vlan_id: "",
  ipv4_mode: "dhcp",
  ipv4_address: "",
  ipv4_prefix: "24",
  ipv4_gateway: "",
  dns_servers: "",
  username: "ubuntu",
  ssh_public_key_variable: "ssh_public_key",
  started: true,
};

function selectItems(
  catalog: Catalog | undefined,
  key: "nodes" | "templates" | "datastores" | "bridges",
) {
  return Array.isArray(catalog?.[key]) ? catalog![key]! : [];
}

function formFromVm(input?: Record<string, unknown> | null) {
  if (!input) return initialForm;
  const address = String(input.ipv4_address || "dhcp");
  const [ipv4Address, prefix] = address.split("/", 2);
  const stringValue = (
    key: Exclude<keyof VmForm, "agent_enabled" | "started">,
  ): string =>
    input[key] == null ? String(initialForm[key]) : String(input[key]);
  return {
    ...initialForm,
    name: stringValue("name"),
    node_name: stringValue("node_name"),
    vm_id: stringValue("vm_id"),
    clone_vm_id: stringValue("clone_vm_id"),
    clone_retries: stringValue("clone_retries"),
    disk_datastore: stringValue("disk_datastore"),
    disk_interface: stringValue("disk_interface"),
    disk_size_gb: stringValue("disk_size_gb"),
    disk_discard: stringValue("disk_discard"),
    cpu_cores: stringValue("cpu_cores"),
    cpu_type: stringValue("cpu_type"),
    memory_mb: stringValue("memory_mb"),
    bridge: stringValue("bridge"),
    vlan_id: stringValue("vlan_id"),
    ipv4_mode: address === "dhcp" ? "dhcp" : "static",
    ipv4_address: address === "dhcp" ? "" : ipv4Address,
    ipv4_prefix:
      address === "dhcp"
        ? initialForm.ipv4_prefix
        : prefix || String(input.ipv4_prefix || initialForm.ipv4_prefix),
    ipv4_gateway: String(input.ipv4_gateway || ""),
    dns_servers: Array.isArray(input.dns_servers)
      ? input.dns_servers.map(String).join(", ")
      : String(input.dns_servers || ""),
    username: stringValue("username"),
    ssh_public_key_variable: String(input.ssh_public_key_variable || ""),
    agent_enabled:
      input.agent_enabled == null
        ? initialForm.agent_enabled
        : Boolean(input.agent_enabled),
    started:
      input.started == null ? initialForm.started : Boolean(input.started),
  } satisfies VmForm;
}

export function VmFormDialog({
  workspaceId,
  vmId,
  environmentId,
  connectionId,
  open,
  onOpenChange,
  initialVm,
}: {
  workspaceId?: string;
  vmId?: string;
  environmentId?: string;
  connectionId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialVm?: Record<string, unknown> | null;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<VmForm>(initialForm);
  const [postDeploy, setPostDeploy] = useState<string[]>([]);
  const [preDeploy, setPreDeploy] = useState<string[]>([]);
  const [preDeployTarget, setPreDeployTarget] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [selectedZone, setSelectedZone] = useState("");
  const isolated = Boolean(vmId || (!workspaceId && environmentId && connectionId));
  const catalogUrl = vmId
    ? `/opentofu/vms/${encodeURIComponent(vmId)}/catalog`
    : workspaceId
      ? `/opentofu/workspaces/${encodeURIComponent(workspaceId)}/proxmox-catalog`
      : `/opentofu/proxmox-connections/${encodeURIComponent(connectionId || "")}/vm-catalog`;
  const catalogQuery = useQuery({
    queryKey: ["opentofu", isolated ? "vm" : "workspace", vmId || workspaceId || connectionId, "catalog", form.node_name],
    queryFn: () =>
      apiFetch<Catalog>(
        `${catalogUrl}${form.node_name ? `?node=${encodeURIComponent(form.node_name)}` : ""}`,
      ),
    enabled: open && Boolean(vmId || workspaceId || connectionId),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const templatesQuery = useQuery({
    queryKey: ["opentofu", "vm-templates", environmentId || workspaceId],
    queryFn: () =>
      apiFetch<{ templates?: VmTemplate[] }>(
        isolated
          ? `/opentofu/vm-templates?environment_id=${encodeURIComponent(environmentId || "")}`
          : `/opentofu/workspaces/${encodeURIComponent(workspaceId || "")}/proxmox-vm-templates`,
      ),
    enabled: open && Boolean(isolated ? environmentId : workspaceId),
    staleTime: 30_000,
  });
  const playbooksQuery = useQuery({
    queryKey: ["playbooks"],
    queryFn: () => api.getPlaybooks() as Promise<Playbook[]>,
    enabled: open,
    staleTime: 60_000,
  });
  const hostsQuery = useQuery({
    queryKey: ["servers", environmentId],
    queryFn: () => api.getServers(environmentId) as unknown as Promise<Host[]>,
    enabled: open && Boolean(environmentId),
    staleTime: 30_000,
  });
  const templates = Array.isArray(templatesQuery.data?.templates)
    ? templatesQuery.data!.templates!
    : [];
  const playbooks = useMemo(
    () =>
      Array.isArray(playbooksQuery.data)
        ? playbooksQuery.data.filter((item) => item.filename)
        : [],
    [playbooksQuery.data],
  );
  const hosts = useMemo(() => Array.isArray(hostsQuery.data) ? hostsQuery.data.filter(host => String(host.environment_id || "default") === environmentId) : [], [environmentId, hostsQuery.data]);

  useEffect(() => {
    if (!open) return;
    setForm(formFromVm(initialVm));
    setPostDeploy(
      Array.isArray(initialVm?.post_deploy_playbooks)
        ? initialVm!.post_deploy_playbooks.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
    );
    setPreDeploy(
      Array.isArray(initialVm?.pre_deploy_playbooks)
        ? initialVm!.pre_deploy_playbooks.filter((item): item is string => typeof item === "string")
        : [],
    );
    setPreDeployTarget(String(initialVm?.pre_deploy_target_server_id || ""));
    setTemplateId("");
    setTemplateName("");
    setSelectedZone("");
  }, [initialVm, open]);

  useEffect(() => {
    const catalog = catalogQuery.data;
    if (!catalog || !open) return;
    setForm((current) => {
      const nextBridge = current.bridge === "vmbr0"
        ? selectItems(catalog, "bridges").find((item) => item.name === "vmbr0")?.name ||
          selectItems(catalog, "bridges")[0]?.name || current.bridge
        : current.bridge;
      const bridgeEntry = selectItems(catalog, "bridges").find((item) => item.name === nextBridge);
      return {
      ...current,
      node_name:
        current.node_name ||
        catalog.node ||
        selectItems(catalog, "nodes")[0]?.name ||
        "",
      vm_id: current.vm_id || String(catalog.next_vm_id || ""),
      disk_datastore:
        current.disk_datastore ||
        selectItems(catalog, "datastores").find((item) => /zfs/i.test(`${item.type || ""} ${item.id || ""}`))?.id ||
        selectItems(catalog, "datastores")[0]?.id ||
        "",
      bridge: nextBridge,
      vlan_id: bridgeEntry?.source === "sdn" && bridgeEntry.vlan_id ? "" : current.vlan_id,
      clone_vm_id:
        current.clone_vm_id === "9000" &&
        selectItems(catalog, "templates")[0]?.vm_id
          ? String(selectItems(catalog, "templates")[0].vm_id)
          : current.clone_vm_id,
    }});
  }, [catalogQuery.data, open]);

  const payload = () => ({
    ...form,
    vm_id: form.vm_id.trim(),
    vlan_id: form.vlan_id.trim(),
    ipv4_address: form.ipv4_mode === "dhcp" ? "dhcp" : form.ipv4_address.trim(),
    ipv4_prefix: form.ipv4_mode === "dhcp" ? null : form.ipv4_prefix.trim(),
    ipv4_gateway: form.ipv4_mode === "dhcp" ? "" : form.ipv4_gateway.trim(),
    dns_servers: form.dns_servers
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean),
    post_deploy_playbooks: postDeploy,
    pre_deploy_playbooks: preDeploy,
    pre_deploy_target_server_id: preDeployTarget,
  });
  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch(
        isolated
          ? `/opentofu/vms${vmId ? `/${encodeURIComponent(vmId)}` : ""}`
          : `/opentofu/workspaces/${encodeURIComponent(workspaceId || "")}/proxmox-vms${initialVm?.id ? `/${encodeURIComponent(String(initialVm.id))}` : ""}`,
        {
          method: vmId || initialVm?.id ? "PUT" : "POST",
          body: { ...payload(), environment_id: environmentId, connection_id: connectionId, template_id: templateId || undefined },
        },
      ),
    onSuccess: () => {
      showToast(
        vmId || initialVm?.id
          ? "VM configuration updated. Review a plan before applying it."
          : "VM created as an isolated OpenTofu deployment.",
        "success",
      );
      void queryClient.invalidateQueries({
        queryKey: ["opentofu"],
      });
      onOpenChange(false);
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const saveTemplateMutation = useMutation({
    mutationFn: () =>
      apiFetch(
        isolated
          ? "/opentofu/vm-templates"
          : `/opentofu/workspaces/${encodeURIComponent(workspaceId || "")}/proxmox-vm-templates`,
        {
          method: "POST",
          body: { name: templateName.trim(), config: payload(), environment_id: environmentId, connection_id: connectionId },
        },
      ),
    onSuccess: () => {
      showToast("VM template saved.", "success");
      setTemplateName("");
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "vm-templates"],
      });
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });

  const update = <K extends keyof VmForm>(key: K, value: VmForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const applyTemplate = (nextId: string) => {
    setTemplateId(nextId);
    const template = templates.find((item) => item.id === nextId);
    if (!template) return;
    const config = template.config || {};
    const address = String(config.ipv4_address || "dhcp");
    const [ip, prefix] = address.split("/", 2);
    setForm((current) => ({
      ...current,
      ...config,
      name: current.name,
      vm_id: current.vm_id,
      ipv4_mode: address === "dhcp" ? "dhcp" : "static",
      ipv4_address: address === "dhcp" ? "" : ip,
      ipv4_prefix:
        address === "dhcp"
          ? current.ipv4_prefix
          : prefix || String(config.ipv4_prefix || "24"),
      ipv4_gateway: String(config.ipv4_gateway || ""),
      dns_servers: Array.isArray(config.dns_servers)
        ? config.dns_servers.map(String).join(", ")
        : String(config.dns_servers || ""),
    }));
    setPostDeploy(
      Array.isArray(config.post_deploy_playbooks)
        ? config.post_deploy_playbooks
        : [],
    );
    setPreDeploy(Array.isArray(config.pre_deploy_playbooks) ? config.pre_deploy_playbooks : []);
    setPreDeployTarget(String(config.pre_deploy_target_server_id || ""));
    showToast(`Template “${template.name}” applied.`, "success");
  };
  const togglePlaybook = (filename: string, checked: boolean) =>
    setPostDeploy((current) =>
      checked
        ? [...current, filename]
        : current.filter((item) => item !== filename),
    );
  const movePlaybook = (index: number, direction: -1 | 1) =>
    setPostDeploy((current) => {
      const next = [...current];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  const togglePreDeploy = (filename: string, checked: boolean) =>
    setPreDeploy((current) => checked ? [...current, filename] : current.filter((item) => item !== filename));
  const movePreDeploy = (index: number, direction: -1 | 1) =>
    setPreDeploy((current) => {
      const next = [...current];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  const catalog = catalogQuery.data;
  const bridgeItems = selectItems(catalog, "bridges");
  const visibleBridges = bridgeItems.filter(
    (item) => item.source !== "sdn" || !selectedZone || item.zone === selectedZone,
  );
  const selectedBridge = bridgeItems.find((item) => item.name === form.bridge);
  const nodeNames = selectItems(catalog, "nodes")
    .map((item) => String(item.name || ""))
    .filter(Boolean);
  const validNode = Boolean(form.node_name) && (
    nodeNames.includes(form.node_name) || catalog?.node === form.node_name
  );
  const validVmId = Number.isInteger(Number(form.vm_id)) && Number(form.vm_id) >= 100;
  const requiredValuesValid = Boolean(
    form.name.trim() && form.clone_vm_id.trim() && form.disk_datastore.trim() &&
    form.bridge.trim() && Number(form.disk_size_gb) > 0 &&
    Number(form.cpu_cores) > 0 && Number(form.memory_mb) > 0 &&
    (form.ipv4_mode === "dhcp" || (
      form.ipv4_address.trim() && form.ipv4_prefix.trim() && form.ipv4_gateway.trim()
    )) &&
    (preDeploy.length === 0 || preDeployTarget)
  );
  const formValid = catalogQuery.isSuccess && !catalogQuery.isFetching &&
    validNode && validVmId && requiredValuesValid;
  const validationMessage = catalogQuery.isPending || catalogQuery.isFetching
    ? "Loading and validating Proxmox node and VM ID …"
    : catalogQuery.isError
      ? "Proxmox inventory must be available before this VM definition can be saved."
      : !validNode
        ? "Select a valid Proxmox node."
        : !validVmId
          ? "VM ID must be an integer of 100 or greater."
          : !requiredValuesValid
            ? "Complete all required compute, storage, network and workflow target fields."
            : "";
  const selectBridge = (value: string) => {
    const item = bridgeItems.find((bridge) => bridge.name === value);
    setForm((current) => ({
      ...current,
      bridge: value,
      vlan_id: item?.source === "sdn" && item.vlan_id ? "" : current.vlan_id,
    }));
    if (item?.source === "sdn" && item.zone) setSelectedZone(item.zone);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-6xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            {initialVm?.id ? "Edit Proxmox VM" : "Add Proxmox VM"}
          </DialogTitle>
          <DialogDescription>
            Shipyard manages this VM in its own isolated OpenTofu state;
            sensitive Proxmox values remain on the selected platform.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-5 lg:grid-cols-2 lg:items-start"
          onSubmit={(event) => {
            event.preventDefault();
            if (formValid) saveMutation.mutate();
          }}
        >
          <div className="min-w-0 space-y-5">
          <section className="rounded-lg border bg-muted/20 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">VM template</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Apply defaults while keeping the name and target VM ID
                  independent.
                </p>
              </div>
            </div>
            <select
              value={templateId}
              onChange={(event) => applyTemplate(event.target.value)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              aria-label="Select VM template"
            >
              <option value="">Do not use a template</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
            <details className="mt-3 border-t pt-3">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                Save current values as a new template
              </summary>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <Input
                  value={templateName}
                  onChange={(event) => setTemplateName(event.target.value)}
                  placeholder="VM template name…"
                  maxLength={63}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    !templateName.trim() || saveTemplateMutation.isPending
                  }
                  onClick={() => saveTemplateMutation.mutate()}
                >
                  {saveTemplateMutation.isPending ? (
                    <RefreshCw className="animate-spin" />
                  ) : (
                    <Plus />
                  )}
                  Save template
                </Button>
              </div>
            </details>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Identity & template</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="VM name">
                <Input
                  required
                  value={form.name}
                  onChange={(event) => update("name", event.target.value)}
                  placeholder="hr01-app-erpnext"
                  pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,62}"
                />
              </Field>
              <Field label="Proxmox node">
                <Select
                  value={form.node_name}
                  onChange={(value) => update("node_name", value)}
                  options={selectItems(catalog, "nodes").map((item) => ({
                    value: item.name || "",
                    label: `${item.name || ""}${item.online === false ? " (offline)" : ""}`,
                  }))}
                />
              </Field>
              <Field
                label="Target VM ID"
                hint="The next available ID is prefilled."
              >
                <Input
                  value={form.vm_id}
                  onChange={(event) => update("vm_id", event.target.value)}
                  inputMode="numeric"
                  type="number"
                  min="100"
                />
              </Field>
              <Field label="Template">
                <Select
                  value={form.clone_vm_id}
                  onChange={(value) => update("clone_vm_id", value)}
                  options={selectItems(catalog, "templates").map((item) => ({
                    value: String(item.vm_id || ""),
                    label: `${item.name || "Template"} (VM ${item.vm_id || "?"})`,
                  }))}
                />
              </Field>
              <Field label="Clone attempts">
                <Input
                  value={form.clone_retries}
                  onChange={(event) =>
                    update("clone_retries", event.target.value)
                  }
                  type="number"
                  min="0"
                  max="10"
                />
              </Field>
            </div>
          </section>

          <section className="space-y-3 border-t pt-5">
            <h3 className="text-sm font-semibold">Compute & Storage</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Datastore">
                <Select
                  value={form.disk_datastore}
                  onChange={(value) => update("disk_datastore", value)}
                  options={selectItems(catalog, "datastores").map((item) => ({
                    value: item.id || "",
                    label: item.id || "",
                  }))}
                />
              </Field>
              <Field label="Disk size (GB)">
                <Input
                  required
                  value={form.disk_size_gb}
                  onChange={(event) =>
                    update("disk_size_gb", event.target.value)
                  }
                  type="number"
                  min="1"
                />
              </Field>
              <Field label="CPU cores">
                <Input
                  required
                  value={form.cpu_cores}
                  onChange={(event) => update("cpu_cores", event.target.value)}
                  type="number"
                  min="1"
                />
              </Field>
              <Field label="Memory (MB)">
                <Input
                  required
                  value={form.memory_mb}
                  onChange={(event) => update("memory_mb", event.target.value)}
                  type="number"
                  min="256"
                />
              </Field>
            </div>
            <details className="border-t pt-3">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                Advanced compute options
              </summary>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <Field label="Disk interface">
                  <Input
                    required
                    value={form.disk_interface}
                    onChange={(event) =>
                      update("disk_interface", event.target.value)
                    }
                  />
                </Field>
                <Field label="CPU type">
                  <Input
                    required
                    value={form.cpu_type}
                    onChange={(event) => update("cpu_type", event.target.value)}
                  />
                </Field>
              </div>
            </details>
          </section>

          </div>
          <div className="min-w-0 space-y-5">

          <section className="space-y-3 border-t pt-5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">Network & VM access</h3>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={catalogQuery.isFetching}
                onClick={() => void catalogQuery.refetch()}
              >
                <RefreshCw className={catalogQuery.isFetching ? "animate-spin" : ""} />
                Refresh Proxmox networks
              </Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {Array.isArray(catalog?.sdn_zones) && catalog.sdn_zones.length > 0 && (
                <Field label="SDN zone" hint="Filters SDN VNets; node bridges remain visible.">
                  <select
                    value={selectedZone}
                    onChange={(event) => setSelectedZone(event.target.value)}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    <option value="">All zones</option>
                    {catalog.sdn_zones.map((zone) => (
                      <option key={zone.name} value={zone.name}>
                        {zone.name}{zone.zone_type || zone.type ? ` (${zone.zone_type || zone.type})` : ""}
                        {zone.available_on_node === false ? " — unavailable on node" : ""}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Bridge / SDN VNet">
                <Input
                  value={form.bridge}
                  onChange={(event) => selectBridge(event.target.value)}
                  list="proxmox-network-targets"
                  placeholder="vmbr0 or a VNet created by pre-deploy"
                />
                <datalist id="proxmox-network-targets">
                  {visibleBridges.filter((item) => item.available_on_node !== false).map((item) => (
                    <option key={`${item.source}-${item.name}`} value={item.name || ""}>
                      {item.source === "sdn" ? `SDN ${item.zone || ""}${item.alias ? ` / ${item.alias}` : ""}` : "Node bridge"}
                    </option>
                  ))}
                </datalist>
                <p className="text-xs text-muted-foreground">You can enter a custom bridge or VNet that a pre-deploy workflow creates later.</p>
              </Field>
              <Field
                label="VM VLAN-ID (optional)"
                hint={selectedBridge?.source === "sdn" && selectedBridge.vlan_id
                  ? `VLAN ${selectedBridge.vlan_id} is defined by the SDN VNet and is not added again to the VM NIC.`
                  : "A NIC tag for a VLAN-aware bridge. SDN VNet VLANs are shown in the network selection."}
              >
                <Input
                  value={form.vlan_id}
                  onChange={(event) => update("vlan_id", event.target.value)}
                  type="number"
                  min="1"
                  max="4094"
                  disabled={selectedBridge?.source === "sdn" && Boolean(selectedBridge.vlan_id)}
                  list="proxmox-sdn-vlans"
                />
                <datalist id="proxmox-sdn-vlans">
                  {(catalog?.vlans || []).map((vlan) => (
                    <option key={`${vlan.vlan_id}-${vlan.vnet}`} value={vlan.vlan_id || ""}>
                      {vlan.vnet ? `${vlan.vnet}${vlan.zone ? ` / ${vlan.zone}` : ""}` : ""}
                    </option>
                  ))}
                </datalist>
              </Field>
              <Field label="IP configuration">
                <select
                  value={form.ipv4_mode}
                  onChange={(event) =>
                    update("ipv4_mode", event.target.value as "dhcp" | "static")
                  }
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="dhcp">DHCP</option>
                  <option value="static">Static</option>
                </select>
              </Field>
              {form.ipv4_mode === "static" && (
                <>
                  <Field label="IPv4 address">
                    <Input
                      required
                      value={form.ipv4_address}
                      onChange={(event) =>
                        update("ipv4_address", event.target.value)
                      }
                      placeholder="10.20.1.20"
                      inputMode="decimal"
                    />
                  </Field>
                  <Field label="Prefix">
                    <Input
                      required
                      value={form.ipv4_prefix}
                      onChange={(event) =>
                        update("ipv4_prefix", event.target.value)
                      }
                      type="number"
                      min="0"
                      max="32"
                    />
                  </Field>
                  <Field label="Gateway (optional)">
                    <Input
                      value={form.ipv4_gateway}
                      onChange={(event) =>
                        update("ipv4_gateway", event.target.value)
                      }
                      placeholder="10.20.1.1"
                      inputMode="decimal"
                    />
                  </Field>
                </>
              )}
              <Field
                label="DNS servers (optional)"
                hint="Comma-separated. Leave empty to inherit DNS from the Proxmox template or DHCP."
              >
                <Input
                  value={form.dns_servers}
                  onChange={(event) => update("dns_servers", event.target.value)}
                  placeholder="10.10.2.1, 1.1.1.1"
                  inputMode="decimal"
                />
              </Field>
              <Field label="VM user">
                <Input
                  required
                  value={form.username}
                  onChange={(event) => update("username", event.target.value)}
                />
              </Field>
            </div>
            {Array.isArray(catalog?.sdn_warnings) && catalog.sdn_warnings.length > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Classic bridges were loaded, but the SDN catalog is incomplete. Check that the Proxmox API token has SDN audit permissions.
              </p>
            )}
            <details className="border-t pt-3">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                Advanced VM access
              </summary>
              <div className="mt-3 max-w-md">
                <Field
                  label="SSH key variable"
                  hint="Leave empty to avoid setting a key through Cloud-Init."
                >
                  <Input
                    value={form.ssh_public_key_variable}
                    onChange={(event) =>
                      update("ssh_public_key_variable", event.target.value)
                    }
                  />
                </Field>
              </div>
            </details>
          </section>

          <details className="group border-t pt-5">
            <summary className="cursor-pointer list-none select-none">
              <div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-semibold">Pre-deploy workflows</h3><p className="mt-0.5 text-xs text-muted-foreground">Run Ansible on an existing host before OpenTofu starts. A failed step stops the deployment.</p></div><span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{preDeploy.length} selected</span></div>
            </summary>
            <div className="mt-3 space-y-3">
              <Field label="Execution host" hint="For example, select the Proxmox host where Ansible creates the VLAN, SDN VNet, or bridge.">
                <select value={preDeployTarget} onChange={(event) => setPreDeployTarget(event.target.value)} required={preDeploy.length > 0} className="h-9 w-full rounded-md border bg-background px-3 text-sm">
                  <option value="">Select host…</option>
                  {hosts.map((host) => <option key={host.id} value={host.id}>{host.name}{host.ip_address ? ` · ${host.ip_address}` : ""}</option>)}
                </select>
              </Field>
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="max-h-52 overflow-y-auto rounded-md border p-2">
                  {playbooks.length ? playbooks.map((playbook) => <label key={playbook.filename} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-2 hover:bg-accent"><input type="checkbox" className="mt-0.5" checked={preDeploy.includes(playbook.filename!)} onChange={(event) => togglePreDeploy(playbook.filename!, event.target.checked)} /><span className="min-w-0"><span className="block text-sm">{playbook.filename}</span>{playbook.description && <span className="block truncate text-xs text-muted-foreground">{playbook.description}</span>}</span></label>) : <p className="p-2 text-sm text-muted-foreground">No playbooks available.</p>}
                </div>
                <div className="min-h-16 space-y-1 rounded-md border p-2">
                  {preDeploy.length ? preDeploy.map((filename, index) => <div key={filename} className="flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1.5"><span className="w-5 text-center font-mono text-xs text-muted-foreground">{index + 1}</span><span className="min-w-0 flex-1 truncate text-sm">{filename}</span><Button type="button" variant="ghost" size="icon" className="h-7 w-7" disabled={index === 0} onClick={() => movePreDeploy(index, -1)} aria-label="Move up"><ArrowUp className="h-3.5 w-3.5" /></Button><Button type="button" variant="ghost" size="icon" className="h-7 w-7" disabled={index === preDeploy.length - 1} onClick={() => movePreDeploy(index, 1)} aria-label="Move down"><ArrowDown className="h-3.5 w-3.5" /></Button><Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => togglePreDeploy(filename, false)} aria-label="Remove"><X className="h-3.5 w-3.5" /></Button></div>) : <p className="p-2 text-sm text-muted-foreground">No pre-deploy workflows selected.</p>}
                </div>
              </div>
            </div>
          </details>

          <details className="group border-t pt-5">
            <summary className="cursor-pointer list-none select-none">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">
                    Post-deploy workflows
                  </h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Optional: run playbooks after a successful apply.
                  </p>
                </div>
                <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {postDeploy.length} selected
                </span>
              </div>
            </summary>
            <div className="mt-3">
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-md border">
                  <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
                    Available playbooks
                  </div>
                  <div className="max-h-48 overflow-y-auto p-2">
                    {playbooks.length ? (
                      playbooks.map((playbook) => {
                        const filename = playbook.filename!;
                        return (
                          <label
                            key={filename}
                            className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-2 hover:bg-accent"
                          >
                            <input
                              type="checkbox"
                              className="mt-0.5"
                              checked={postDeploy.includes(filename)}
                              onChange={(event) =>
                                togglePlaybook(filename, event.target.checked)
                              }
                            />
                            <span className="min-w-0">
                              <span className="block text-sm">{filename}</span>
                              {playbook.description && (
                                <span className="block truncate text-xs text-muted-foreground">
                                  {playbook.description}
                                </span>
                              )}
                            </span>
                          </label>
                        );
                      })
                    ) : (
                      <p className="p-2 text-sm text-muted-foreground">
                        No playbooks available.
                      </p>
                    )}
                  </div>
                </div>
                <div className="rounded-md border">
                  <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
                    Execution order
                  </div>
                  <div className="min-h-16 space-y-1 p-2">
                    {postDeploy.length ? (
                      postDeploy.map((filename, index) => (
                        <div
                          key={filename}
                          className="flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1.5"
                        >
                          <span className="w-5 text-center text-xs font-mono text-muted-foreground">
                            {index + 1}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm">
                            {filename}
                          </span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            disabled={index === 0}
                            onClick={() => movePlaybook(index, -1)}
                            aria-label="Move up"
                          >
                            <ArrowUp className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            disabled={index === postDeploy.length - 1}
                            onClick={() => movePlaybook(index, 1)}
                            aria-label="Move down"
                          >
                            <ArrowDown className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            onClick={() => togglePlaybook(filename, false)}
                            aria-label="Remove"
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))
                    ) : (
                      <p className="p-2 text-sm text-muted-foreground">
                        No workflows selected.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </details>

          <details className="border-t pt-5">
            <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
              Advanced VM options
            </summary>
            <div className="mt-3 flex flex-wrap gap-5 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.agent_enabled}
                  onChange={(event) =>
                    update("agent_enabled", event.target.checked)
                  }
                />
                Enable QEMU Guest Agent
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.started}
                  onChange={(event) => update("started", event.target.checked)}
                />
                Start VM after deployment
              </label>
            </div>
          </details>
          </div>
          {catalogQuery.isError && (
            <p className="text-sm text-destructive lg:col-span-2">
              Proxmox inventory could not be loaded. Retry the inventory load
              before saving this definition.
            </p>
          )}
          {!formValid && !catalogQuery.isError && (
            <p className="text-sm text-amber-700 dark:text-amber-300 lg:col-span-2">{validationMessage}</p>
          )}
          <DialogFooter className="lg:col-span-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saveMutation.isPending || !formValid}>
              {saveMutation.isPending ? (
                <RefreshCw className="animate-spin" />
              ) : (
                <Plus />
              )}
              {initialVm?.id
                ? "Update VM definition"
                : "Save VM definition"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
}) {
  const allOptions =
    value && !options.some((option) => option.value === value)
      ? [{ value, label: `${value} (current)` }, ...options]
      : options;
  return (
    <select
      required
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-9 w-full rounded-md border bg-background px-3 text-sm"
    >
      <option value="" disabled>
        {options.length ? "Select…" : "Loading…"}
      </option>
      {allOptions.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
