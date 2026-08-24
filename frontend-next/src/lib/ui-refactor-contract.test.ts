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
    expect(sidebar).toContain(">Infrastructure</div>");
    expect(sidebar).toContain(">System</div>");
    expect(tree).toContain("const nodeOpen = !collapsed.has(nodeKey)");
    expect(tree).toContain('to="/infrastructure/$clusterId/nodes/$nodeName/vms/$vmId"');
  });

  it("prioritizes host tabs and moves secondary modules into Tools", () => {
    const page = source("features/server-detail/ServerDetailPage.tsx");
    expect(page).toContain('<TabsTrigger value="overview">');
    expect(page).toContain('<TabsTrigger value="updates">System &amp; Updates</TabsTrigger>');
    expect(page).toContain('<TabsTrigger value="terminal">');
    expect(page).toContain('title="Host tools"');
    expect(page).not.toContain('<TabsTrigger value="docker">');
    expect(page).not.toContain('<TabsTrigger value="files">');
    expect(page).not.toContain('<TabsTrigger value="notes">');
  });

  it("renders plugin paths as code pills instead of raw HTML copy", () => {
    const locale = source("locales/en.json");
    const plugins = source("routes/settings/tabs/plugins.tsx");
    expect(locale).not.toContain("<code style=");
    expect(plugins).toContain("<code>{t('set.pluginsPath')}</code>");
  });
});
