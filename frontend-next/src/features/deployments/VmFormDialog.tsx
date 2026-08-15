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
}
interface Catalog {
  node?: string;
  next_vm_id?: string | number;
  nodes?: CatalogItem[];
  templates?: CatalogItem[];
  datastores?: CatalogItem[];
  bridges?: CatalogItem[];
}
interface VmTemplate {
  id: string;
  name: string;
  config: Partial<VmForm> & { post_deploy_playbooks?: string[] };
}
interface Playbook {
  filename?: string;
  name?: string;
  description?: string;
}

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
  open,
  onOpenChange,
  initialVm,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialVm?: Record<string, unknown> | null;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<VmForm>(initialForm);
  const [postDeploy, setPostDeploy] = useState<string[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const catalogQuery = useQuery({
    queryKey: ["opentofu", "workspace", workspaceId, "catalog", form.node_name],
    queryFn: () =>
      apiFetch<Catalog>(
        `/opentofu/workspaces/${encodeURIComponent(workspaceId)}/proxmox-catalog${form.node_name ? `?node=${encodeURIComponent(form.node_name)}` : ""}`,
      ),
    enabled: open,
    staleTime: 30_000,
  });
  const templatesQuery = useQuery({
    queryKey: ["opentofu", "workspace", workspaceId, "vm-templates"],
    queryFn: () =>
      apiFetch<{ templates?: VmTemplate[] }>(
        `/opentofu/workspaces/${encodeURIComponent(workspaceId)}/proxmox-vm-templates`,
      ),
    enabled: open,
    staleTime: 30_000,
  });
  const playbooksQuery = useQuery({
    queryKey: ["playbooks"],
    queryFn: () => api.getPlaybooks() as Promise<Playbook[]>,
    enabled: open,
    staleTime: 60_000,
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
    setTemplateId("");
    setTemplateName("");
  }, [initialVm, open]);

  useEffect(() => {
    const catalog = catalogQuery.data;
    if (!catalog || !open) return;
    setForm((current) => ({
      ...current,
      node_name:
        current.node_name ||
        catalog.node ||
        selectItems(catalog, "nodes")[0]?.name ||
        "",
      vm_id: current.vm_id || String(catalog.next_vm_id || ""),
      disk_datastore:
        current.disk_datastore ||
        selectItems(catalog, "datastores")[0]?.id ||
        "",
      bridge:
        current.bridge === "vmbr0"
          ? selectItems(catalog, "bridges").find(
              (item) => item.name === "vmbr0",
            )?.name ||
            selectItems(catalog, "bridges")[0]?.name ||
            current.bridge
          : current.bridge,
      clone_vm_id:
        current.clone_vm_id === "9000" &&
        selectItems(catalog, "templates")[0]?.vm_id
          ? String(selectItems(catalog, "templates")[0].vm_id)
          : current.clone_vm_id,
    }));
  }, [catalogQuery.data, open]);

  const payload = () => ({
    ...form,
    vm_id: form.vm_id.trim(),
    vlan_id: form.vlan_id.trim(),
    ipv4_address: form.ipv4_mode === "dhcp" ? "dhcp" : form.ipv4_address.trim(),
    ipv4_prefix: form.ipv4_mode === "dhcp" ? null : form.ipv4_prefix.trim(),
    ipv4_gateway: form.ipv4_mode === "dhcp" ? "" : form.ipv4_gateway.trim(),
    post_deploy_playbooks: postDeploy,
  });
  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch(
        `/opentofu/workspaces/${encodeURIComponent(workspaceId)}/proxmox-vms${initialVm?.id ? `/${encodeURIComponent(String(initialVm.id))}` : ""}`,
        { method: initialVm?.id ? "PUT" : "POST", body: payload() },
      ),
    onSuccess: () => {
      showToast(
        initialVm?.id
          ? "VM definition updated. OpenTofu files were adjusted."
          : "VM definition saved. OpenTofu files were updated.",
        "success",
      );
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "workspace", workspaceId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "workspaces"],
      });
      onOpenChange(false);
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const saveTemplateMutation = useMutation({
    mutationFn: () =>
      apiFetch(
        `/opentofu/workspaces/${encodeURIComponent(workspaceId)}/proxmox-vm-templates`,
        {
          method: "POST",
          body: { name: templateName.trim(), config: payload() },
        },
      ),
    onSuccess: () => {
      showToast("VM template saved.", "success");
      setTemplateName("");
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "workspace", workspaceId, "vm-templates"],
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
    }));
    setPostDeploy(
      Array.isArray(config.post_deploy_playbooks)
        ? config.post_deploy_playbooks
        : [],
    );
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
  const catalog = catalogQuery.data;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            {initialVm?.id ? "Edit Proxmox VM" : "Add Proxmox VM"}
          </DialogTitle>
          <DialogDescription>
            Fleet generates the required OpenTofu files; sensitive Proxmox
            values remain stored as workspace variables.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            saveMutation.mutate();
          }}
        >
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
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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

          <section className="space-y-3 border-t pt-5">
            <h3 className="text-sm font-semibold">Network & guest access</h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Bridge">
                <Select
                  value={form.bridge}
                  onChange={(value) => update("bridge", value)}
                  options={selectItems(catalog, "bridges").map((item) => ({
                    value: item.name || "",
                    label: `${item.name || ""}${item.active === false ? " (inactive)" : ""}`,
                  }))}
                />
              </Field>
              <Field label="VLAN-ID (optional)">
                <Input
                  value={form.vlan_id}
                  onChange={(event) => update("vlan_id", event.target.value)}
                  type="number"
                  min="1"
                  max="4094"
                />
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
              <Field label="Guest user">
                <Input
                  required
                  value={form.username}
                  onChange={(event) => update("username", event.target.value)}
                />
              </Field>
            </div>
            <details className="border-t pt-3">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                Advanced guest access
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
          {catalogQuery.isError && (
            <p className="text-sm text-destructive">
              Proxmox inventory could not be loaded. Existing form values can
              still be used.
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saveMutation.isPending}>
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
  options: Array<{ value: string; label: string }>;
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
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
