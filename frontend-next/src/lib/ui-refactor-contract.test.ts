import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (relative: string) =>
  readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

describe("UI refactor contract", () => {
  it("keeps IPAM and virtual guest tables on the compact shared density", () => {
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

  it("keeps VM creation split into two desktop columns", () => {
    const dialog = source("features/deployments/VmFormDialog.tsx");
    expect(dialog).toContain('className="grid gap-5 lg:grid-cols-2 lg:items-start"');
    expect(dialog.match(/className="min-w-0 space-y-5"/g)).toHaveLength(2);
    expect(dialog).toContain("Compute & Storage");
    expect(dialog).toContain("Network & guest access");
    expect(dialog).toContain("Post-deploy workflows");
  });

  it("renders the infrastructure navigation as node and guest accordions", () => {
    const sidebar = source("components/layout/Sidebar.tsx");
    const tree = source("components/layout/InfrastructureTree.tsx");
    expect(sidebar).toContain('t("nav.infrastructure")');
    expect(sidebar).toContain('t("nav.system")');
    expect(tree).toContain("const nodeOpen = !collapsed.has(nodeKey)");
    expect(tree).toContain('to="/infrastructure/$clusterId/nodes/$nodeName/vms/$vmId"');
    expect(tree).toContain("!platformServerIds.has(server.id)");
    expect(tree).toContain('to="/servers/$id"');
    expect(tree).toContain("{vm.fleet_server_id ? (");
    expect(tree).toContain('title={`Open managed host ${vm.name || vmId}`}');
    expect(tree).toContain('title="Open Proxmox guest details"');
    expect(tree).toContain("showInfrastructureVmIds");
    expect(tree).toContain("{showVmIds && <span");
  });

  it("keeps the requested host sections visible and places Docker in the primary tab rail", () => {
    const page = source("features/server-detail/ServerDetailPage.tsx");
    expect(page).toContain('<TabsTrigger value="overview">');
    expect(page).toContain('<TabsTrigger value="configuration">{t("common.details")}</TabsTrigger>');
    expect(page).toContain('<TabsTrigger value="files">{t("det.tabFiles")}</TabsTrigger>');
    expect(page).toContain('<TabsTrigger value="history">{t("det.tabOperations")}</TabsTrigger>');
    expect(page).toContain('<TabsTrigger value="notes">');
    expect(page).toContain('<TabsTrigger value="updates">{t("det.tabSystemUpdates")}</TabsTrigger>');
    expect(page).toContain('<TabsTrigger value="terminal" data-terminal-trigger="true">');
    expect(page).toContain('title={t("det.hostTools")}');
    expect(page).toContain('<TabsTrigger value="docker">');
    expect(page).not.toContain('OverflowItem icon={Box}');
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
    expect(vm).toContain("Unsaved guest data may be lost.");
    expect(vm).toContain('variant={powerAction === "stop" ? "destructive" : "warning"}');
  });
});
