import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (relative: string) =>
  readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

describe("UI refactor contract", () => {
  it("keeps IPAM and virtual machine tables on the compact shared density", () => {
    for (const file of [
      "routes/networks.tsx",
      "routes/network-detail.tsx",
      "features/infrastructure/DetailPanels.tsx",
    ]) {
      const contents = source(file);
      expect(contents.match(/<table/g)?.length || 0).toBe(
        contents.match(/data-density="compact"/g)?.length || 0,
      );
    }

    const css = source("index.css");
    expect(css).toContain("padding: 0.5rem 0.75rem !important");
    expect(css).toContain("border-bottom: 1px solid hsl(var(--border-subtle))");
    expect(css).toMatch(/nth-child\(even\)[\s\S]*?background-color: transparent/);
  });

  it("uses a quiet positive status treatment and accessible secondary text", () => {
    const badge = source("components/ui/status-badge.tsx");
    const genericBadge = source("components/ui/badge.tsx");
    const css = source("index.css");
    expect(badge).toContain("success: 'bg-transparent");
    expect(genericBadge).toContain('success:     "border-success/20 bg-transparent');
    expect(css).toContain("input::placeholder, textarea::placeholder { color: hsl(var(--muted-foreground)); }");
  });

  it("uses one compact rectangular switch treatment throughout the app", () => {
    const uiSwitch = source("components/ui/switch.tsx");
    const hostDialog = source("components/CreateServerDialog.tsx");
    expect(uiSwitch).toContain("h-4 w-8");
    expect(uiSwitch).toContain("rounded-[4px]");
    expect(uiSwitch).toContain("h-3 w-3 rounded-[2px]");
    expect(uiSwitch).not.toContain("rounded-full");
    expect(hostDialog).toContain('import { Switch } from "@/components/ui/switch"');
    expect(hostDialog).not.toContain('role="switch"');
  });

  it("keeps VM creation split into two desktop columns", () => {
    const dialog = source("features/deployments/VmFormDialog.tsx");
    expect(dialog).toContain('className="grid gap-5 lg:grid-cols-2 lg:items-start"');
    expect(dialog.match(/className="min-w-0 space-y-5"/g)).toHaveLength(2);
    expect(dialog).toContain("Compute & Storage");
    expect(dialog).toContain("Network & VM access");
    expect(dialog).toContain("Post-deploy workflows");
  });

  it("separates Operations and Infrastructure while keeping the tree infrastructure-only", () => {
    const sidebar = source("components/layout/Sidebar.tsx");
    const tree = source("components/layout/InfrastructureTree.tsx");
    expect(sidebar).toContain('value: "operations"');
    expect(sidebar).toContain('value: "infrastructure"');
    expect(sidebar).toContain('workspace === "operations" ? (');
    expect(sidebar).toContain("<InfrastructureTree onNavigate={onMobileClose} />");
    expect(sidebar).toContain('t("nav.managedHosts")');
    expect(sidebar).toContain('t("nav.managedVirtualMachines")');
    expect(sidebar).toContain('t("nav.networksIpam")');
    expect(sidebar).not.toContain('t("nav.platforms")');
    expect(sidebar).not.toContain('t("nav.nodes")');
    expect(sidebar).not.toContain('t("nav.virtualMachinesContainers")');
    expect(sidebar).not.toContain('t("nav.datastores")');
    expect(sidebar).toContain('t("nav.administration")');
    expect(sidebar).not.toContain('t("nav.profile")');
    expect(sidebar).toContain('t("nav.help")');
    expect(tree).toContain("const nodeOpen = !collapsed.has(nodeKey)");
    expect(tree).toContain('to="/infrastructure/$clusterId/nodes/$nodeName/vms/$vmId"');
    expect(tree).toContain("!platformServerIds.has(server.id)");
    expect(tree).toContain('to="/servers/$id"');
    expect(tree).toContain("{vm.fleet_server_id ? (");
    expect(tree).toContain('title={`Open managed host ${vm.name || vmId}`}');
    expect(tree).toContain('title="Open Proxmox virtual machine details"');
    expect(tree).toContain("showInfrastructureVmIds");
    expect(tree).toContain("{showVmIds && <span");
  });

  it("uses the requested host tabs and places Files and Terminal under Access", () => {
    const page = source("features/server-detail/ServerDetailPage.tsx");
    expect(page).toContain('<TabsTrigger value="overview">');
    expect(page).toContain('<TabsTrigger value="configuration">{t("det.tabSystem")}</TabsTrigger>');
    expect(page).toContain('<TabsTrigger value="docker">{t("det.tabWorkloads")}</TabsTrigger>');
    expect(page).toContain('<TabsTrigger value="updates">{t("det.tabUpdates")}</TabsTrigger>');
    expect(page).toContain('<TabsTrigger value="history">{t("det.tabActivity")}</TabsTrigger>');
    expect(page).toContain('<TabsTrigger value="notes">');
    expect(page).toContain('<TabsTrigger value="access">{t("det.tabAccess")}</TabsTrigger>');
    expect(page).toContain("<ServerFilesTab serverId={id} profile={profile} />");
    expect(page).toContain("setTerminalOpen(true)");
    expect(page).not.toContain('<TabsTrigger value="files">');
    expect(page).not.toContain('<TabsTrigger value="terminal"');
  });

  it("renders plugin paths as code pills instead of raw HTML copy", () => {
    const locale = source("locales/en.json");
    const plugins = source("routes/settings/tabs/plugins.tsx");
    expect(locale).not.toContain("<code style=");
    expect(plugins).toContain("<code>{t('set.pluginsPath')}</code>");
  });

  it("keeps comfortable density and flexible navigation user-configurable", () => {
    const store = source("lib/store.ts");
    const sidebar = source("components/layout/Sidebar.tsx");
    const shell = source("components/layout/AppShell.tsx");
    expect(store).toContain("return 'comfortable'");
    expect(store).toContain("sidebarWidth: readSidebarWidth()");
    expect(store).toContain("infrastructureTreeCollapsed");
    expect(sidebar).toContain("onPointerDown={startResize}");
    expect(sidebar).toContain("toggleInfrastructureTree");
    expect(sidebar).not.toContain("shipyard_recent_nav");
    expect(shell).toContain("setDensity(value)");
    expect(shell).toContain("md:hidden\" onClick={openCommandPalette}");
  });

  it("opens operational dashboard metrics as filtered work queues", () => {
    const dashboard = source("routes/dashboard.tsx");
    const servers = source("features/servers/ServersPage.tsx");
    const router = source("router.tsx");
    expect(dashboard).toContain("dataUpdatedAt");
    expect(dashboard).toContain("search={{ status: 'offline' }}");
    expect(dashboard).toContain("search={{ updates: true }}");
    expect(dashboard).toContain("search={{ scope: 'active' }}");
    expect(dashboard).toContain("search={{ scope: 'failed' }}");
    expect(servers).toContain("routeSearch.updates === true");
    expect(servers).toContain("routeSearch.attention === true");
    expect(router).toContain("interface ServersSearch");
    expect(router).toContain("interface OperationsSearch");
  });

  it("keeps the primary host action clear and secondary actions in overflow", () => {
    const servers = source("features/servers/ServersPage.tsx");
    expect(servers.indexOf("<CreateServerDialog />")).toBeLessThan(servers.indexOf('<OverflowMenu title={t("srv.resourceOptions")}>'));
    expect(servers).toContain("<OverflowItem icon={RefreshCw} onClick={handleRefresh}");
  });

  it("names fleet selection controls and the command search explicitly", () => {
    const servers = source("features/servers/ServersPage.tsx");
    const palette = source("components/CommandPalette.tsx");
    expect(servers).toContain('aria-label={`Select ${s.name}`}');
    expect(servers.match(/aria-label=\{t\("common\.all"\)\}/g)).toHaveLength(2);
    expect(palette).toContain("aria-label={t('cmd.placeholder')}");
  });

  it("requires the VM name for an immediate force stop", () => {
    const vm = source("routes/proxmox-vm-detail.tsx");
    expect(vm).toContain('powerAction === "stop" ? `STOP ${vm.name}` : undefined');
    expect(vm).toContain("Unsaved virtual machine data may be lost.");
    expect(vm).toContain('variant={powerAction === "stop" ? "destructive" : "warning"}');
  });

  it("keeps playbook creation central and targeting reviewable", () => {
    const page = source("features/playbooks/PlaybooksPage.tsx");
    const templates = source("features/playbooks/PlaybookTemplates.tsx");
    const runs = source("features/playbooks/PlaybookRuns.tsx");
    const variables = source("features/playbooks/PlaybookVariables.tsx");
    expect(page).toContain("setCreateRequest((value) => value + 1)");
    expect(templates).not.toContain("const startNew");
    expect(runs).toContain('placeholder="Search name, IP, or tag"');
    expect(runs).toContain('aria-label="Filter hosts by group"');
    expect(runs).toContain('aria-label="Filter hosts by tag"');
    expect(runs).toContain("<summary className=\"cursor-pointer text-sm font-medium\">Advanced options</summary>");
    expect(variables).toContain('{ label: "Secrets"');
    expect(variables).toContain('v.is_secret ? "••••••••"');
  });

  it("focuses audit on security and configuration changes by default", () => {
    const audit = source("features/operations/AuditLogPanel.tsx");
    expect(audit).toContain('useState<"changes" | "all">("changes")');
    expect(audit).toContain("Security & changes");
    expect(audit).toContain("All events");
  });
});
