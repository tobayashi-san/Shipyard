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
    const css = source("index.css");
    expect(uiSwitch).toContain("h-5 w-10");
    expect(uiSwitch).toContain("rounded-[6px]");
    expect(uiSwitch).toContain("h-3.5 w-3.5 rounded-[3px]");
    expect(uiSwitch).toContain("data-[state=checked]:translate-x-[22px]");
    expect(uiSwitch).toContain("data-[state=unchecked]:translate-x-[2px]");
    expect(css).toContain('main button:not([role="switch"])');
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
    expect(sidebar).toContain('workspace === "operations"');
    expect(sidebar).toContain('"flex flex-col gap-1 overflow-hidden"');
    expect(sidebar).toContain('data-testid="infrastructure-tree-scroll" className="min-h-0 flex-1 overflow-y-auto py-1"');
    expect(sidebar.indexOf('label={t("nav.networksIpam")}')).toBeLessThan(
      sidebar.indexOf('<InfrastructureTree onNavigate={onMobileClose} />'),
    );
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

  it("keeps host reachability in the page header instead of repeating it in the overview", () => {
    const page = source("features/server-detail/ServerDetailPage.tsx");
    const overview = source("features/server-detail/ServerOverviewTabs.tsx");
    expect(page).toContain('server.status === "online"');
    expect(overview).not.toContain('label="Connection"');
    expect(overview).not.toContain("<StatusBadge");
    expect(overview).toContain("Management mode");
    expect(overview).not.toContain("Verwaltungsmodus");
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

  it("keeps implementation paths out of normal deployment copy and administration actions in menus", () => {
    const deployment = source("features/deployments/DeploymentSettingsDialog.tsx");
    const onboarding = source("routes/onboarding.tsx");
    const users = source("routes/settings/tabs/users-roles.tsx");
    expect(deployment).not.toContain("OpenTofu path");
    expect(deployment).not.toContain("workspace.path");
    expect(onboarding).toContain("changed later in Administration");
    expect(onboarding).not.toContain("changed later in Settings");
    expect(users).toContain("<OverflowMenu title={`Actions for ${shown}`}>");
    expect(users).toContain("<OverflowMenu title={`Actions for ${r.name}`}>");
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

  it("never presents failed operations queries as healthy empty activity", () => {
    const operations = source("routes/operations.tsx");
    expect(operations).toContain("operationsQuery.isError ? (");
    expect(operations).toContain('title="Activity could not be loaded"');
    expect(operations).toContain('title="Maintenance windows could not be loaded"');
    expect(operations).toContain("operationsQuery.isSuccess && (!canViewMaintenance || maintenanceQuery.isSuccess)");
  });

  it("distinguishes infrastructure detail failures from confirmed empty inventory", () => {
    const infrastructure = source("routes/infrastructure-detail.tsx");
    const vm = source("routes/proxmox-vm-detail.tsx");
    expect(infrastructure).toContain('title="Infrastructure inventory could not be loaded"');
    expect(vm).toContain('title="Virtual machine inventory could not be loaded"');
    expect(vm).toContain('title="Virtual machine configuration could not be loaded"');
    expect(vm).toContain('title="VM management context could not be loaded"');
    expect(vm).toContain('title="Snapshots could not be loaded"');
    expect(vm).toContain('title="VM tasks could not be loaded"');
    expect(vm).toContain('(vmTabs.value === "overview" || vmTabs.value === "snapshots")');
    expect(vm).toContain('(vmTabs.value === "overview" || vmTabs.value === "tasks")');
    expect(vm).not.toContain('Connections, declaration, and management for this virtual\n                  virtual machine.');
    const detailPanels = source("features/infrastructure/DetailPanels.tsx");
    const cluster = source("features/infrastructure/ClusterDetail.tsx");
    const node = source("features/infrastructure/NodeDetail.tsx");
    expect(detailPanels).toContain('title="Object tasks could not be loaded"');
    expect(cluster).toContain("showAudit && (");
    expect(node).toContain("showAudit && (");
    expect(cluster).not.toContain("{auditTasks.length}");
    expect(node).not.toContain("{auditTasks.length}");
    const createVm = source("features/deployments/CreateDeploymentDialog.tsx");
    const sourceDialog = source("features/deployments/DeploymentConnectionDialog.tsx");
    expect(createVm).toContain('title="Proxmox platforms could not be loaded"');
    expect(createVm).toContain("connections.length === 0 && connectionsQuery.isSuccess");
    expect(sourceDialog).toContain('title="Infrastructure source could not be loaded"');
  });

  it("keeps icon and context actions keyboard and screen-reader accessible", () => {
    const menu = source("components/ui/overflow-menu.tsx");
    const button = source("components/ui/button.tsx");
    const host = source("features/server-detail/ServerDetailPage.tsx");
    const docker = source("features/server-detail/ServerDockerTab.tsx");
    const overview = source("features/server-detail/ServerOverviewTabs.tsx");
    const summaryCards = source("features/server-detail/components/summary-cards.tsx");
    const servers = source("features/servers/ServersPage.tsx");

    expect(button).toContain("icon: 'h-10 w-10 min-h-9 min-w-9'");
    expect(menu).toContain("['ArrowDown', 'ArrowUp', 'Home', 'End']");
    expect(menu).toContain("triggerRef.current?.focus()");
    expect(menu).toContain('role="separator"');
    expect(menu).toContain("flex min-h-9 w-full");
    expect(host).toContain('aria-label={t("common.back")}');
    expect(docker).toContain('aria-label={t("common.refresh")}');
    expect(overview).toContain('aria-label={t("common.refresh")}');
    expect(summaryCards).toContain("aria-label={`${t('common.copy')} ${label}`}");
    expect(servers).toContain("aria-label={`Remove ${name} from playbook targets`}");
  });

  it("never presents failed playbook or administration references as empty data", () => {
    const runs = source("features/playbooks/PlaybookRuns.tsx");
    const schedules = source("features/playbooks/PlaybookSchedules.tsx");
    const history = source("features/playbooks/PlaybookHistory.tsx");
    const variables = source("features/playbooks/PlaybookVariables.tsx");
    const templates = source("features/playbooks/PlaybookTemplates.tsx");
    const users = source("routes/settings/tabs/users-roles.tsx");
    const ssh = source("routes/settings/tabs/ssh.tsx");
    const git = source("routes/settings/tabs/git.tsx");

    expect(runs).toContain('title="Playbook run references could not be loaded"');
    expect(schedules).toContain('title="Scheduled workflows could not be loaded"');
    expect(schedules).toContain('title="Workflow references could not be loaded"');
    expect(history).toContain('title="Playbook run history could not be loaded"');
    expect(variables).toContain('title="Variables and secrets could not be loaded"');
    expect(templates).toContain('title="Playbook targets could not be loaded"');
    expect(templates).toContain('title="Playbook content could not be loaded"');
    expect(templates).toContain('title="Playbook version history could not be loaded"');
    expect(users).toContain('title="Users and roles could not be loaded"');
    expect(users).toContain('title="Role scope references could not be loaded"');
    expect(ssh).toContain('title="Key assignments could not be loaded"');
    expect(ssh).toContain('title="SSH deployment targets could not be loaded"');
    expect(git).toContain('title="Git branches could not be loaded"');
  });

  it("keeps global, host, deployment and IPAM query failures actionable", () => {
    const shell = source("components/layout/AppShell.tsx");
    const palette = source("components/CommandPalette.tsx");
    const tree = source("components/layout/InfrastructureTree.tsx");
    const login = source("routes/login.tsx");
    const dashboard = source("routes/dashboard.tsx");
    const servers = source("features/servers/ServersPage.tsx");
    const audit = source("features/operations/AuditLogPanel.tsx");
    const deployment = source("routes/deployment-detail.tsx");
    const vmForm = source("features/deployments/VmFormDialog.tsx");
    const infrastructure = source("routes/infrastructure.tsx");
    const profile = source("routes/profile.tsx");
    const createHost = source("components/CreateServerDialog.tsx");
    const locale = source("locales/en.json");

    expect(shell).toContain('title="Console permissions could not be loaded"');
    expect(shell).toContain("Environments could not be loaded.");
    expect(palette).toContain("Some search results could not be loaded.");
    expect(tree).toContain("Managed hosts could not be loaded");
    expect(login).toContain('title="Shipyard could not be reached"');
    expect(dashboard).toContain('title="Failed operation count could not be loaded"');
    expect(servers).toContain('title="Host folders could not be loaded"');
    expect(servers).toContain('title="Playbooks could not be loaded"');
    expect(audit).toContain('title="Audit filters could not be loaded"');
    expect(deployment).toContain('title="Managed VM could not be loaded"');
    expect(deployment).toContain('title="Current Proxmox state could not be loaded"');
    expect(deployment).toContain('title="Independent VM state could not be loaded"');
    expect(deployment).toContain('title="VM run history could not be loaded"');
    expect(deployment).toContain("runStateUnavailable");
    expect(vmForm).toContain('title="VM templates could not be loaded"');
    expect(vmForm).toContain('title="Pre-deploy hosts could not be loaded"');
    expect(infrastructure).toContain("inventoryQuery.isSuccess && hostsQuery.isSuccess");
    expect(profile).toContain('title="Two-factor authentication status could not be loaded"');
    expect(createHost).toContain('title="Environments could not be loaded"');
    expect(locale).toContain('"managedHostReferencesFailed"');
    expect(locale).toContain('"reservationValidationFailed"');
  });

  it("preserves the operational review fixes across narrow and long-form views", () => {
    const networks = source("routes/networks.tsx");
    const sidebar = source("components/layout/Sidebar.tsx");
    const operations = source("routes/operations.tsx");
    const router = source("router.tsx");
    const playbooks = source("features/playbooks/PlaybooksPage.tsx");
    const profile = source("routes/profile.tsx");
    const users = source("routes/settings/tabs/users-roles.tsx");
    const activity = source("components/ActivityCenter.tsx");

    expect(networks).toContain('className="min-w-0 space-y-5"');
    expect(networks).toContain('className="hidden md:block"');
    expect(networks).toContain("function PrefixMobileCard");
    expect(networks).toContain('tr("vlanBridge")');
    expect(networks).toContain('tr("descriptionLabel")');
    expect(sidebar.match(/<NavItem to="\/operations"/g)).toHaveLength(1);
    expect(sidebar).toContain("shipyard.lastInfrastructureRoute");
    expect(operations).not.toContain('| "Audit"');
    expect(operations).not.toContain('<option value="Audit">');
    expect(router).not.toContain("'Workflow' | 'Audit'");
    expect(playbooks).toContain('to: "/settings/$tab", params: { tab: "git" }');
    expect(playbooks).toContain("Git settings");
    expect(profile.indexOf("profile.passwordSection")).toBeLessThan(profile.indexOf("Personal appearance"));
    expect(profile).toContain("More themes");
    expect(users).toContain("flex max-h-[90vh] max-w-4xl flex-col overflow-hidden p-0");
    expect(users).toContain("shrink-0 border-t bg-card px-5 py-3");
    expect(users).toContain("{users.length} users");
    expect(activity).toContain("serverNames.get(text(data.serverId))");
    expect(activity).not.toContain("`Host ${text(data.serverId)}`");
    expect(activity).toContain("Cause:");
  });
});
