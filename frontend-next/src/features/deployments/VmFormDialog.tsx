import { useNavigate } from '@tanstack/react-router';
import { validateVmForm, VM_STEPS } from './vm-form-validation';
import { VmIpamSelection, type Selection } from './VmIpamSelection';
import { resolveIpamNetwork } from './ipam-network';
import { useEffect, useMemo, useState, useRef, useId, Children, createContext, useContext, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
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
import { QueryErrorState } from "@/components/ui/query-error-state";

const FieldErrors = createContext<Record<string, string>>({});

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
  ssh_public_key_configured?: boolean;
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
    playbook_variables?: Record<string, string | number | boolean>;
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
  ssh_port: string;
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
  bridge: "",
  vlan_id: "",
  ipv4_mode: "dhcp",
  ipv4_address: "",
  ipv4_prefix: "24",
  ipv4_gateway: "",
  dns_servers: "",
  username: "",
  ssh_port: "22",
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
    ssh_port: String(input.ssh_port || 22),
    ssh_public_key_variable: String(input.ssh_public_key_variable || ""),
    agent_enabled:
      input.agent_enabled == null
        ? initialForm.agent_enabled
        : Boolean(input.agent_enabled),
    started:
      input.started == null ? initialForm.started : Boolean(input.started),
  } satisfies VmForm;
}

interface VmFormDialogProps {
  workspaceId?: string;
  vmId?: string;
  environmentId?: string;
  connectionId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialVm?: Record<string, unknown> | null;
}
const workflows = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
type VariableRow = { key: string; value: string };
const variableRows = (value: unknown): VariableRow[] =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value as Record<string, unknown>).map(([key, item]) => ({ key, value: String(item ?? '') }))
    : [];
const variablesPayload = (rows: VariableRow[]) =>
  Object.fromEntries(rows.filter(row => row.key.trim()).map(row => [row.key.trim(), row.value]));
/** Mirrors the server rules so a mistake shows next to the field instead of on save. */
function variableError(row: VariableRow, rows: VariableRow[]) {
  const key = row.key.trim();
  if (!key) return row.value ? 'Enter a name for this value.' : '';
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) return 'Use letters, digits and underscores, starting with a letter.';
  if (/^(ansible|fleet)_/i.test(key)) return 'Names starting with ansible_ or fleet_ are reserved.';
  if (rows.filter(item => item.key.trim() === key).length > 1) return 'This name is used twice.';
  return '';
}
function baselineFor(vm?: Record<string, unknown> | null) {
  return JSON.stringify([formFromVm(vm), workflows(vm?.post_deploy_playbooks), workflows(vm?.pre_deploy_playbooks), String(vm?.pre_deploy_target_server_id || ''), variablesPayload(variableRows(vm?.playbook_variables))]);
}
export function VmFormDialog(props: VmFormDialogProps) {
  if (!props.open) return null;
  return <VmFormContent key={JSON.stringify([props.environmentId, props.connectionId, props.workspaceId, props.vmId, props.initialVm?.id])} {...props} />;
}
function VmFormContent({workspaceId, vmId, environmentId, connectionId, open, onOpenChange, initialVm}: VmFormDialogProps) {
  const active = useRef(true);
  useEffect(() => {active.current = true; return () => {active.current = false;};}, []);
  const [baseline] = useState(() => baselineFor(initialVm));
  const changedOnServer = baselineFor(initialVm) !== baseline;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [showErrors, setShowErrors] = useState(false);
  const [form, setForm] = useState<VmForm>(() => formFromVm(initialVm));
  const [postDeploy, setPostDeploy] = useState<string[]>(() => workflows(initialVm?.post_deploy_playbooks));
  const [preDeploy, setPreDeploy] = useState<string[]>(() => workflows(initialVm?.pre_deploy_playbooks));
  const [preDeployTarget, setPreDeployTarget] = useState(() => String(initialVm?.pre_deploy_target_server_id || ""));
  const [variables, setVariables] = useState<VariableRow[]>(() => variableRows(initialVm?.playbook_variables));
  const variablesInvalid = variables.some(row => variableError(row, variables));
  const [templateId, setTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [selectedZone, setSelectedZone] = useState("");
  const [networkSearch, setNetworkSearch] = useState("");
  const [mappingMessage, setMappingMessage] = useState("");
  const isolated = Boolean(vmId || (!workspaceId && environmentId && connectionId));
  const catalogUrl = vmId
    ? `/opentofu/vms/${encodeURIComponent(vmId)}/catalog`
    : workspaceId
      ? `/opentofu/workspaces/${encodeURIComponent(workspaceId)}/proxmox-catalog`
      : `/opentofu/proxmox-connections/${encodeURIComponent(connectionId || "")}/vm-catalog`;
  const catalogQuery = useQuery({
    queryKey: ["opentofu", isolated ? "vm" : "workspace", vmId || workspaceId || connectionId, "catalog", environmentId, form.node_name],
    queryFn: () =>
      apiFetch<Catalog>(
        `${catalogUrl}${form.node_name ? `?node=${encodeURIComponent(form.node_name)}` : ""}`,
        { environmentId },
      ),
    enabled: open && Boolean(vmId || workspaceId || connectionId),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const [checkedId, setCheckedId] = useState(form.vm_id);
  useEffect(() => { const timer = setTimeout(() => setCheckedId(form.vm_id), 350); return () => clearTimeout(timer); }, [form.vm_id]);
  const idCheckQuery = useQuery({
    queryKey: ['opentofu', 'vm-id-check', vmId || connectionId, checkedId, environmentId],
    queryFn: () => apiFetch<{ available: boolean; owned?: boolean; occupied: { name: string; node: string }[] }>(`${vmId ? `/opentofu/vms/${encodeURIComponent(vmId)}` : `/opentofu/proxmox-connections/${encodeURIComponent(connectionId || '')}`}/vm-id-check?id=${encodeURIComponent(checkedId)}`, { environmentId }),
    enabled: open && isolated && Number(checkedId) >= 100,
    staleTime: 0,
  });
  const templatesQuery = useQuery({
    queryKey: ["opentofu", "vm-templates", environmentId || workspaceId],
    queryFn: () =>
      apiFetch<{ templates?: VmTemplate[] }>(
        isolated
          ? `/opentofu/vm-templates?environment_id=${encodeURIComponent(environmentId || "")}`
          : `/opentofu/workspaces/${encodeURIComponent(workspaceId || "")}/proxmox-vm-templates`,
        { environmentId },
      ),
    enabled: open && Boolean(isolated ? environmentId : workspaceId),
    staleTime: 30_000,
  });
  const playbooksQuery = useQuery({
    queryKey: ["playbooks", environmentId],
    queryFn: () => apiFetch<Playbook[]>("/playbooks", { environmentId }),
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
    const catalog = catalogQuery.data;
    if (!catalog || !open) return;
    setForm((current) => {
      const nextBridge = current.bridge;
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
    playbook_variables: variablesPayload(variables),
  });
  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch<{id: string}>(
        isolated
          ? `/opentofu/vms${vmId ? `/${encodeURIComponent(vmId)}` : ""}`
          : `/opentofu/workspaces/${encodeURIComponent(workspaceId || "")}/proxmox-vms${initialVm?.id ? `/${encodeURIComponent(String(initialVm.id))}` : ""}`,
        {
          method: vmId || initialVm?.id ? "PUT" : "POST",
          environmentId,
          body: { ...payload(), environment_id: environmentId, connection_id: connectionId, template_id: templateId || undefined },
        },
      ),
    onSuccess: result => {
      void queryClient.invalidateQueries({queryKey: ["opentofu"]});
      if (!active.current) return;
      showToast(
        vmId || initialVm?.id
          ? "VM configuration updated. Review a plan before applying it."
          : "Draft saved — not deployed. Create a plan to continue.",
        "success",
      );
      void queryClient.invalidateQueries({
        queryKey: ["opentofu"],
      });
      onOpenChange(false);
      if (isolated && !vmId && !initialVm?.id && result?.id) void navigate({ to: '/deployments/$id', params: { id: result.id } });
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
          environmentId,
          body: { name: templateName.trim(), config: payload(), environment_id: environmentId, connection_id: connectionId },
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({queryKey: ["opentofu"]});
      if (!active.current) return;
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
    setVariables(variableRows(config.playbook_variables));
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
    (item) => item.name === form.bridge || item.source !== "sdn" || !selectedZone || item.zone === selectedZone,
  );
  const selectedBridge = bridgeItems.find((item) => item.name === form.bridge);
  const nodeNames = selectItems(catalog, "nodes")
    .map((item) => String(item.name || ""))
    .filter(Boolean);
  const validNode = Boolean(form.node_name) && (
    nodeNames.includes(form.node_name) || catalog?.node === form.node_name
  );
  const validVmId = Number.isInteger(Number(form.vm_id)) && Number(form.vm_id) >= 100;
  const validation = validateVmForm({ ...form }, preDeploy, preDeployTarget);
  if (form.ssh_public_key_variable && catalogQuery.data?.ssh_public_key_configured === false) {
    validation.errors['SSH key variable'] = 'Save Fleet’s public key under Settings → Connections before deploying.';
    validation.steps[2].push('SSH key variable');
  }
  if (!selectedBridge || selectedBridge.available_on_node === false) { validation.errors['Bridge / SDN VNet'] = 'Select a bridge or VNet available on this node.'; validation.steps[2].push('Bridge / SDN VNet'); }
  if (!validNode) validation.errors['Proxmox node'] = 'Select a node from the current platform inventory.';
  const existingId = Boolean(vmId && idCheckQuery.data?.owned && String(initialVm?.vm_id) === form.vm_id);
  const idVerified = !isolated || (checkedId === form.vm_id && idCheckQuery.isSuccess && !idCheckQuery.isFetching && (idCheckQuery.data.available || existingId));
  if (!idVerified) { validation.errors['Target VM ID'] = idCheckQuery.isError ? 'VM ID check failed. Check the Proxmox connection and retry.' : idCheckQuery.data?.available === false ? 'This VM ID is occupied. Choose a free ID.' : 'Checking VM ID availability…'; validation.steps[0].push('Target VM ID'); }
  const requiredValuesValid = Object.keys(validation.errors).length === 0;
  const formValid = !changedOnServer && catalogQuery.isSuccess && !catalogQuery.isFetching && validNode && validVmId && requiredValuesValid && !variablesInvalid;
  const nextStep = () => {
    setShowErrors(true);
    if (step === 0 && (!validNode || !catalogQuery.isSuccess || catalogQuery.isFetching)) return;
    if (validation.steps[step]?.length) return;
    setStep(current => Math.min(current + 1, 4));
    setShowErrors(false);
  };
  const applyIpamNetwork = (selection: Pick<Selection, 'bridge' | 'connectionId' | 'vlan'>) => {
    const targetConnection = connectionId || String(initialVm?.connection_id || '');
    const resolved = resolveIpamNetwork(selection, bridgeItems, targetConnection);
    setMappingMessage(resolved.message);
    // Only preselect a zone the filter can show; a hidden filter could not be cleared.
    const zone = bridgeItems.find(item => item.name === resolved.bridge && item.source === 'sdn')?.zone;
    const zones = Array.isArray(catalog?.sdn_zones) ? catalog.sdn_zones : [];
    setSelectedZone(zone && zones.some(item => item.name === zone) ? zone : '');
    setForm(current => ({...current, bridge: resolved.bridge, vlan_id: resolved.vlan}));
  };
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
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-5xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            {initialVm?.id ? "Edit Proxmox VM" : "Add Proxmox VM"}
          </DialogTitle>
          <DialogDescription>
            Configure a VM in five steps. Saving creates a definition; review the deployment plan before applying it.
          </DialogDescription>
        </DialogHeader>
        {changedOnServer && <p role="alert" className="rounded-md border border-destructive p-3 text-sm">The saved VM configuration changed while this form was open. Your draft is preserved. Close and reopen the form to review the current configuration before saving.</p>}
        <label className="text-sm sm:hidden">Step {step + 1} of {VM_STEPS.length}<select aria-label="VM setup step" className="mt-1 h-9 w-full rounded-md border bg-background px-2" value={step} onChange={event => { setStep(Number(event.target.value)); setShowErrors(false); }}>{VM_STEPS.map((label,index) => <option key={label} value={index}>{index + 1}. {label}</option>)}</select></label>
        <nav aria-label="VM setup steps" className="hidden shrink-0 flex-wrap gap-2 sm:flex">
          {VM_STEPS.map((label, index) => <Button key={label} type="button" size="sm" variant={step === index ? 'default' : 'outline'} aria-current={step === index ? 'step' : undefined} onClick={() => { setStep(index); setShowErrors(false); }}>{index + 1}. {label}</Button>)}
        </nav>
        <FieldErrors.Provider value={showErrors ? validation.errors : {}}>
        <form noValidate
          className="flex min-h-0 flex-col overflow-hidden"
          onSubmit={(event) => {
            event.preventDefault();
            if (step < 4) { nextStep(); return; }
            setShowErrors(true);
            if (formValid && !saveMutation.isPending) saveMutation.mutate();
          }}
        >
          <div className="min-h-0 overflow-y-auto overscroll-contain space-y-5 p-1" data-dialog-body>
          <div className="min-w-0 space-y-5">
          <fieldset hidden={step !== 0} disabled={step !== 0} className="space-y-5">
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
            {templatesQuery.isError && (
              <QueryErrorState
                compact
                className="py-3"
                error={templatesQuery.error}
                title="VM templates could not be loaded"
                onRetry={() => void templatesQuery.refetch()}
              />
            )}
            <select
              value={templateId}
              onChange={(event) => applyTemplate(event.target.value)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              aria-label="Select VM template"
              disabled={templatesQuery.isLoading || templatesQuery.isError}
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
                {isolated && <p role="status" className="text-xs text-muted-foreground">{!idVerified ? validation.errors['Target VM ID'] : idCheckQuery.data?.available ? 'VM ID is available. It will be checked again before deployment.' : 'VM ID is occupied. Ownership will be verified before any deployment.'}</p>}
                {idCheckQuery.isError && <Button type="button" variant="outline" onClick={() => void idCheckQuery.refetch()}>Retry ID check</Button>}
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

            </div>
          </section>

          </fieldset>
          <fieldset hidden={step !== 1} disabled={step !== 1}>
          <section className="space-y-3">
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
              <Field label="Disk size (GiB)">
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
              <Field label="Memory (MiB)" hint={`${(Number(form.memory_mb) / 1024).toFixed(2)} GiB`}>
                <Input
                  required
                  value={form.memory_mb}
                  onChange={(event) => update("memory_mb", event.target.value)}
                  type="number"
                  min="256"
                />
              </Field>
            </div>
            <details open={showErrors && validation.steps[1].length > 0 ? true : undefined} className="border-t pt-3">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                Advanced compute options
              </summary>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
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
          </fieldset>
          </div>
          <div className="min-w-0 space-y-5">
          <fieldset hidden={step !== 2} disabled={step !== 2}>
            {step === 2 && environmentId && <VmIpamSelection key={environmentId} environmentId={environmentId} onNetwork={applyIpamNetwork} onUse={selection => { applyIpamNetwork(selection); setForm(current => ({...current, ipv4_mode: 'static', ipv4_address: selection.address, ipv4_prefix: selection.prefix, ipv4_gateway: selection.gateway, ...(selection.dns ? {dns_servers: selection.dns} : {})})); }} />}
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
                <Input aria-label="Search bridges and VNets" value={networkSearch} onChange={event => setNetworkSearch(event.target.value)} placeholder="Search bridges and VNets" />
                <select aria-label="Bridge / SDN VNet" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={form.bridge} onChange={event => { selectBridge(event.target.value); setMappingMessage(''); }}>
                  <option value="">Select a bridge or VNet</option>
                  {(['node', 'sdn'] as const).map(source => <optgroup key={source} label={source === 'node' ? 'Node bridges' : 'SDN VNets'}>
                    {visibleBridges.filter(item => (item.source || 'node') === source && (item.name === form.bridge || `${item.name} ${item.alias || ''} ${item.zone || ''}`.toLowerCase().includes(networkSearch.toLowerCase()))).map(item => <option key={item.name} value={item.name} disabled={item.available_on_node === false}>{item.name}{item.alias ? ` · ${item.alias}` : ''}{item.zone ? ` · ${item.zone}` : ''}{item.available_on_node === false ? ' — unavailable on this node' : ''}</option>)}
                  </optgroup>)}
                </select>
                {form.bridge && catalogQuery.isSuccess && (!selectedBridge || selectedBridge.available_on_node === false) && <p role="alert" className="text-xs text-destructive">The selected bridge or VNet is unavailable on this node. Select another network.</p>}
                {mappingMessage && <p role="status" className="text-xs text-muted-foreground">{mappingMessage}</p>}
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
              <Field label="SSH port" hint="The port configured in the guest template."><Input type="number" min={1} max={65535} required value={form.ssh_port} onChange={event => update('ssh_port', event.target.value)} /></Field>
              <Field label="VM user" hint="Choose the account for this guest OS, for example debian or ubuntu. Saved VM templates can supply this value.">
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
                  hint="Uses the public key saved under Settings → Connections. Leave empty only if the template already accepts Fleet’s SSH key."
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

          </fieldset>
          <fieldset hidden={step !== 3} disabled={step !== 3} className="space-y-5">
          <p className="text-sm text-muted-foreground">Workflows are optional. Review their order and execution host before continuing.</p>
          <details className="group border-t pt-5">
            <summary className="cursor-pointer list-none select-none">
              <div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-semibold">Pre-deploy workflows</h3><p className="mt-0.5 text-xs text-muted-foreground">Run Ansible on an existing host before OpenTofu starts. A failed step stops the deployment.</p></div><span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{preDeploy.length} selected</span></div>
            </summary>
            <div className="mt-3 space-y-3">
              {hostsQuery.isError && (
                <QueryErrorState
                  compact
                  className="py-3"
                  error={hostsQuery.error}
                  title="Pre-deploy hosts could not be loaded"
                  onRetry={() => void hostsQuery.refetch()}
                />
              )}
              <Field label="Execution host" hint="For example, select the Proxmox host where Ansible creates the VLAN, SDN VNet, or bridge.">
                <select value={preDeployTarget} onChange={(event) => setPreDeployTarget(event.target.value)} required={preDeploy.length > 0} disabled={hostsQuery.isLoading || hostsQuery.isError} className="h-9 w-full rounded-md border bg-background px-3 text-sm">
                  <option value="">Select host…</option>
                  {hosts.map((host) => <option key={host.id} value={host.id}>{host.name}{host.ip_address ? ` · ${host.ip_address}` : ""}</option>)}
                </select>
              </Field>
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="max-h-52 overflow-y-auto rounded-md border p-2">
                  {playbooksQuery.isError ? <QueryErrorState compact className="py-3" error={playbooksQuery.error} title="Pre-deploy playbooks could not be loaded" onRetry={() => void playbooksQuery.refetch()} /> : playbooks.length ? playbooks.map((playbook) => <label key={playbook.filename} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-2 hover:bg-accent"><input type="checkbox" className="mt-0.5" checked={preDeploy.includes(playbook.filename!)} onChange={(event) => togglePreDeploy(playbook.filename!, event.target.checked)} /><span className="min-w-0"><span className="block text-sm">{playbook.filename}</span>{playbook.description && <span className="block truncate text-xs text-muted-foreground">{playbook.description}</span>}</span></label>) : <p className="p-2 text-sm text-muted-foreground">No playbooks available.</p>}
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
                    {playbooksQuery.isError ? (
                      <QueryErrorState compact className="py-3" error={playbooksQuery.error} title="Post-deploy playbooks could not be loaded" onRetry={() => void playbooksQuery.refetch()} />
                    ) : playbooks.length ? (
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

          <details className="group border-t pt-5" open={variables.length > 0 || undefined}>
            <summary className="cursor-pointer list-none select-none">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">Workflow variables</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Optional: values for the pre- and post-deploy workflows of this VM, for example pfsense_target_alias.
                  </p>
                </div>
                <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {variables.filter(row => row.key.trim()).length} set
                </span>
              </div>
            </summary>
            <div className="mt-3 space-y-2">
              {variables.map((row, index) => {
                const error = variableError(row, variables);
                const set = (patch: Partial<VariableRow>) => setVariables(current => current.map((item, position) => position === index ? { ...item, ...patch } : item));
                return (
                  <div key={index} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Input aria-label={`Variable ${index + 1} name`} aria-invalid={Boolean(error)} className="h-8 flex-1 font-mono text-xs" placeholder="name" value={row.key} onChange={event => set({ key: event.target.value })} />
                      <Input aria-label={`Variable ${index + 1} value`} className="h-8 flex-[2] font-mono text-xs" placeholder="value" value={row.value} onChange={event => set({ value: event.target.value })} />
                      <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-destructive hover:text-destructive" aria-label={`Remove variable ${index + 1}`} onClick={() => setVariables(current => current.filter((_, position) => position !== index))}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    {error && <p className="text-xs text-destructive">{error}</p>}
                  </div>
                );
              })}
              <Button type="button" variant="outline" size="sm" disabled={variables.length >= 30} onClick={() => setVariables(current => [...current, { key: '', value: '' }])}>
                <Plus className="h-3.5 w-3.5" /> Add variable
              </Button>
              <p className="text-xs text-muted-foreground">
                These values override environment variables with the same name. They are stored with the VM in plain text; keep passwords and tokens under Automations › Variables &amp; Secrets and mark them secret.
              </p>
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
          </fieldset>
          </div>
          {step === 4 && <section aria-label="Review VM definition" className="space-y-4">
            <h3 className="font-semibold">Review VM definition</h3>
            {[
              ['Identity', `${form.name || 'Name required'} · VM ${form.vm_id} · ${form.node_name} · template ${form.clone_vm_id}`],
              ['Resources', `${form.cpu_cores} cores · ${form.memory_mb} MiB RAM · ${form.disk_size_gb} GiB disk on ${form.disk_datastore}`],
              ['Network', `${form.bridge}${form.vlan_id ? ` · VLAN ${form.vlan_id}` : ''} · ${form.ipv4_mode === 'dhcp' ? 'DHCP' : `${form.ipv4_address}/${form.ipv4_prefix}`} · gateway ${form.ipv4_gateway || 'inherited / none'}`],
              ['Access', `Login: ${form.username || 'required'} · DNS: ${form.dns_servers || 'inherited'} · SSH key variable: ${form.ssh_public_key_variable || 'none'}`],
              ['Before deployment', `${preDeploy.join(' → ') || 'No workflows'}${preDeploy.length ? ` on ${hosts.find(host => host.id === preDeployTarget)?.name || preDeployTarget}` : ''}`],
              ['After deployment', postDeploy.join(' → ') || 'No workflows'],
              ['Workflow variables', Object.entries(variablesPayload(variables)).map(([key, value]) => `${key}=${value}`).join(' · ') || 'None'],
              ['Options', `Guest agent configured: ${form.agent_enabled ? 'yes' : 'no'} · Start after deployment: ${form.started ? 'yes' : 'no'} · Clone attempts: ${form.clone_retries}`],
            ].map(([label, value]) => <div key={label} className="rounded-md border p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="text-sm break-words">{value}</p></div>)}
            {variablesInvalid && <div role="alert" className="rounded-md border border-destructive p-3 text-sm">Fix the workflow variables marked on the previous step before saving.</div>}
            {!requiredValuesValid && <div role="alert" className="rounded-md border border-destructive p-3 text-sm"><p className="font-medium">Resolve these fields before saving:</p><ul>{Object.entries(validation.errors).map(([label, error]) => <li key={label}>{label}: {error}</li>)}</ul></div>}
          </section>}
          {catalogQuery.isError && (
            <p className="text-sm text-destructive lg:col-span-2">
              Proxmox inventory could not be loaded. Retry the inventory load
              before saving this definition.
            </p>
          )}
          {catalogQuery.isFetching && <p role="status" className="text-sm text-muted-foreground">Refreshing platform inventory…</p>}
          <aside className="text-sm text-muted-foreground">
            {form.name || 'New VM'} · {form.cpu_cores} cores · {(Number(form.memory_mb) / 1024).toFixed(2)} GiB RAM · {form.disk_size_gb} GiB disk · {form.node_name || 'Select node'}
          </aside>
          </div>
          <DialogFooter className="shrink-0 flex-row flex-wrap justify-end border-t bg-card pt-3 mt-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            {step > 0 && <Button type="button" variant="outline" onClick={() => { setStep(step - 1); setShowErrors(false); }}>Back</Button>}
            {step < 4 ? <Button type="submit">Continue</Button> : <Button type="submit" disabled={saveMutation.isPending || !formValid}>
              {saveMutation.isPending ? (
                <RefreshCw className="animate-spin" />
              ) : (
                <Plus />
              )}
              {initialVm?.id
                ? "Update VM definition"
                : "Save VM definition"}
            </Button>}
          </DialogFooter>
        </form>
        </FieldErrors.Provider>
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
  const id = useId();
  const error = useContext(FieldErrors)[label];
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {Children.map(children, child => isValidElement(child) && (child.type === Input || child.type === Select || child.type === 'select' || child.type === 'input') ? cloneElement(child as ReactElement<{ id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }>, { id, 'aria-invalid': Boolean(error), 'aria-describedby': `${id}-hint` }) : child)}
      <div id={`${id}-hint`}>{hint && <p className="text-xs text-muted-foreground">{hint}</p>}{error && <p role="alert" className="text-xs text-destructive">{error}</p>}</div>
    </div>
  );
}

function Select({
  id,
  'aria-invalid': ariaInvalid,
  'aria-describedby': describedBy,
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  id?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}) {
  const allOptions =
    value && !options.some((option) => option.value === value)
      ? [{ value, label: `${value} (current)` }, ...options]
      : options;
  return (
    <select
      id={id} aria-invalid={ariaInvalid} aria-describedby={describedBy}
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
