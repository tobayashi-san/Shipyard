import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field } from '@/features/ipam/CreatePrefixDialog';
import { SourceTestResult, SyncSource, tr } from '@/features/ipam/prefix-model';
import { apiFetch } from "@/lib/api";
import { hasCap, useProfile } from "@/lib/queries";
import { showToast } from "@/lib/toast";
import { formatDateTime } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	DatabaseZap,
	Pencil,
	Plus,
	RefreshCw,
	Settings2,
	Trash2
} from "lucide-react";
import { useState } from "react";

export interface IpamSourcesProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  environmentId: string;
  embedded?: boolean;
}

export function IpamSourcesDialog(props: IpamSourcesProps) {
  return <IpamSourcesContent key={props.environmentId} {...props} />;
}

export function IpamSourcesContent({
  open = true,
  onOpenChange = () => undefined,
  environmentId,
  embedded = false,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  environmentId: string;
  embedded?: boolean;
}) {
  const queryClient = useQueryClient();
  const { data: profile } = useProfile();
  const canEdit = hasCap(profile, "canEditServers");
  const [creating, setCreating] = useState(false);
  const [editingSource, setEditingSource] = useState<SyncSource | null>(null);
  const [type, setType] = useState<"unifi" | "pfsense">("unifi");
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [site, setSite] = useState("default");
  const [path, setPath] = useState("");
  const [insecure, setInsecure] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [autoSync, setAutoSync] = useState(true);
  const [syncInterval, setSyncInterval] = useState("15");
  const [sourceToRemove, setSourceToRemove] = useState<SyncSource | null>(null);
  const [sourceToSync, setSourceToSync] = useState<SyncSource | null>(null);
  const [testReport, setTestReport] = useState<{
    source: SyncSource;
    result: SourceTestResult;
  } | null>(null);
  const query = useQuery({
    queryKey: ["ipam", "sources", environmentId],
    queryFn: () =>
      apiFetch<SyncSource[]>(
        `/ipam/sources?environment_id=${encodeURIComponent(environmentId)}`,
        { environmentId },
      ),
    enabled: open || embedded,
  });
  const sources = Array.isArray(query.data) ? query.data : [];
  const refresh = () =>
    void queryClient.invalidateQueries({
      queryKey: ["ipam", "sources", environmentId],
    });
  const resetForm = () => {
    setCreating(false);
    setEditingSource(null);
    setName("");
    setEndpoint("");
    setToken("");
    setPath("");
    setSite("default");
    setInsecure(false);
    setEnabled(true);
    setAutoSync(true);
    setSyncInterval("15");
  };
  const save = useMutation({
    mutationFn: () =>
      editingSource
        ? apiFetch(`/ipam/sources/${encodeURIComponent(editingSource.id)}`, {
            method: "PUT",
            environmentId,
            body: {
              type,
              name,
              endpoint,
              api_token: token || undefined,
              site,
              path,
              insecure,
              enabled,
              auto_sync: autoSync,
              sync_interval_min: syncInterval,
            },
          })
        : apiFetch("/ipam/sources", {
            method: "POST",
            environmentId,
            body: {
              environment_id: environmentId,
              type,
              name,
              endpoint,
              api_token: token,
              site,
              path,
              insecure,
              enabled,
              auto_sync: autoSync,
              sync_interval_min: syncInterval,
            },
          }),
    onSuccess: () => {
      const wasEditing = Boolean(editingSource);
      resetForm();
      refresh();
      showToast(
        wasEditing ? tr("sourceUpdated") : tr("sourceSaved"),
        "success",
      );
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const test = useMutation({
    mutationFn: (source: SyncSource) =>
      apiFetch<SourceTestResult>(
        `/ipam/sources/${encodeURIComponent(source.id)}/test`,
        { method: "POST", environmentId },
      ),
    onSuccess: (result, source) => {
      refresh();
      setTestReport({ source, result });
      showToast(
        tr("connectionSuccess", { count: result.records }),
        result.matching_prefixes ? "success" : "warning",
      );
    },
    onError: (error: Error) => {
      refresh();
      showToast(error.message, "error");
    },
  });
  const sync = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{
        created: number;
        updated: number;
        removed: number;
        conflicts: number;
        ignored: number;
      }>(`/ipam/sources/${encodeURIComponent(id)}/sync`, { method: "POST", environmentId }),
    onSuccess: (result) => {
      setSourceToSync(null);
      refresh();
      void queryClient.invalidateQueries({ queryKey: ["ipam"] });
      const changes = [
        tr("syncCreated", { count: result.created }),
        tr("syncUpdated", { count: result.updated }),
      ];
      if (result.removed) changes.push(tr("syncReleased", { count: result.removed }));
      if (result.conflicts) changes.push(tr("syncConflicts", { count: result.conflicts }));
      if (result.ignored)
        changes.push(tr("syncOutside", { count: result.ignored }));
      showToast(
        tr("syncResult", { changes: changes.join(", ") }),
        result.conflicts ? "warning" : "success",
      );
    },
    onError: (error: Error) => {
      refresh();
      showToast(error.message, "error");
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/ipam/sources/${encodeURIComponent(id)}`, { method: "DELETE", environmentId }),
    onSuccess: () => {
      setSourceToRemove(null);
      refresh();
      void queryClient.invalidateQueries({ queryKey: ["ipam"] });
      showToast(
        tr("sourceRemoved"),
        "success",
      );
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const beginCreate = () => {
    save.reset();
    resetForm();
    setType("unifi");
    setCreating(true);
  };
  const beginEdit = (source: SyncSource) => {
    save.reset();
    setEditingSource(source);
    setType(source.type);
    setName(source.name);
    setEndpoint(source.endpoint);
    setToken("");
    setSite(source.site || "default");
    setPath(
      source.type === "pfsense" && source.path === "/api/v2/status/dhcp_leases"
        ? "/api/v2/status/dhcp_server/leases"
        : source.path || "",
    );
    setInsecure(source.insecure);
    setEnabled(source.enabled);
    setAutoSync(source.auto_sync !== false);
    setSyncInterval(String(source.sync_interval_min || 15));
    setCreating(true);
  };
  const defaultPath =
    type === "unifi"
      ? `/proxy/network/api/s/${encodeURIComponent(site || "default")}/stat/sta`
      : "/api/v2/status/dhcp_server/leases";
  const endpointPlaceholder =
    type === "pfsense"
      ? tr("pfsenseEndpointPlaceholder")
      : tr("sourceEndpointPlaceholder");
  const content = (
    <>
          {!embedded && (
            <DialogHeader className="min-w-0 border-b px-4 py-4 text-left sm:px-5">
              <DialogTitle className="flex items-center gap-2">
                <DatabaseZap className="h-5 w-5" />
                {tr("sourceTitle")}
              </DialogTitle>
              <DialogDescription>{tr("sourceDescription")}</DialogDescription>
            </DialogHeader>
          )}
          <div className={embedded ? "min-w-0 space-y-4" : "min-w-0 space-y-4 p-3 sm:p-5"}>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer font-medium text-foreground">{tr("automaticMaintenance").replace(/:$/, "")}</summary>
              <p className="mt-1">{tr("automaticMaintenanceDescription")}</p>
            </details>
            {query.isError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/[0.04] p-4 text-sm">
                <div className="font-medium text-destructive">
                  {tr("sourcesLoadFailed")}
                </div>
                <p className="mt-1 text-muted-foreground">
                  {tr("sourcesLoadFailedDescription")}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={() => void query.refetch()}
                >
                  <RefreshCw />
                  {tr("tryAgain")}
                </Button>
              </div>
            ) : query.isPending ? (
              <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
                {tr("loadingSources")}
              </div>
            ) : (
              <>
                {sources.length > 0 && (
                  <div data-ipam-source-list className="space-y-3">
                    {sources.map((source) => {
                      const testing = test.isPending;
                      const syncing = sync.isPending;
                      const testStatus =
                        source.last_test_status === "success"
                          ? {
                              label: tr("connectionVerified"),
                              variant: "success" as const,
                            }
                          : source.last_test_status === "failed"
                            ? {
                                label: tr("connectionFailed"),
                                variant: "destructive" as const,
                              }
                            : {
                                label: tr("notChecked"),
                                variant: "outline" as const,
                              };
                      const syncStatus =
                        source.last_status === "failed"
                          ? {
                              label: tr("lastSyncFailed"),
                              variant: "destructive" as const,
                            }
                          : source.last_synced_at
                            ? {
                                label: tr("synchronized"),
                                variant: "success" as const,
                              }
                            : {
                                label: tr("notSynchronized"),
                                variant: "outline" as const,
                              };

                      return (
                        <section
                          key={source.id}
                          className="min-w-0 overflow-hidden rounded-panel border border-border-strong/70 bg-card"
                        >
                          <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="font-medium">{source.name}</h3>
                                {source.name.trim().toLowerCase() !== (source.type === "unifi" ? "unifi" : "pfsense") && (
                                  <Badge variant="outline">
                                    {source.type === "unifi"
                                      ? "UniFi"
                                      : "pfSense"}
                                  </Badge>
                                )}
                                {!source.enabled && (
                                  <Badge variant="muted">{tr("disabled")}</Badge>
                                )}
                              </div>
                              <p
                                className="mt-1 truncate font-mono text-xs text-muted-foreground"
                                title={`${source.endpoint}${source.path || ""}`}
                              >
                                {source.endpoint}
                                {source.path || ""}
                              </p>
                            </div>
                            {canEdit && <div className="ipam-source-actions">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                aria-label={`${tr("test")} ${source.name}`}
                                disabled={testing || !source.enabled}
                                className="w-full min-w-0 max-w-full overflow-hidden px-2 text-xs sm:w-auto sm:px-3 sm:text-sm"
                                onClick={() => test.mutate(source)}
                              >
                                <RefreshCw
                                  className={
                                    testing
                                      ? "hidden h-4 w-4 animate-spin sm:mr-1.5 sm:block"
                                      : "hidden h-4 w-4 sm:mr-1.5 sm:block"
                                  }
                                />
                                <span className="sm:hidden">{tr("test")}</span>
                                <span className="hidden sm:inline">{tr("testConnection")}</span>
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                aria-label={`${tr("sync")} ${source.name}`}
                                disabled={syncing || !source.enabled}
                                className="w-full min-w-0 max-w-full overflow-hidden px-2 text-xs sm:w-auto sm:px-3 sm:text-sm"
                                onClick={() => { sync.reset(); setSourceToSync(source); }}
                              >
                                <DatabaseZap className="hidden h-4 w-4 sm:mr-1.5 sm:block" />
                                <span className="sm:hidden">{tr("sync")}</span>
                                <span className="hidden sm:inline">{tr("syncNow")}</span>
                              </Button>
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                title={tr("editSource")}
                                aria-label={`${tr("editSource")} ${source.name}`}
                                onClick={() => beginEdit(source)}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                title={tr("removeSource")}
                                aria-label={`${tr("removeSource")} ${source.name}`}
                                className="text-destructive hover:text-destructive"
                                onClick={() => { remove.reset(); setSourceToRemove(source); }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>}
                          </div>

                          <div className="grid border-t bg-muted/[0.18] sm:grid-cols-3">
                            <div className="border-b px-4 py-3 sm:border-b-0 sm:border-r">
                              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                {tr("connection")}
                              </p>
                              <div className="mt-1.5">
                                <Badge variant={testStatus.variant}>
                                  {testStatus.label}
                                </Badge>
                              </div>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {source.last_tested_at
                                  ? tr("testedAt", { date: formatDateTime(source.last_tested_at) })
                                  : tr("noConnectionTest")}
                              </p>
                              {source.last_test_error && (
                                <p
                                  className="mt-1 truncate text-xs text-destructive"
                                  title={source.last_test_error}
                                >
                                  {source.last_test_error}
                                </p>
                              )}
                            </div>
                            <div className="border-b px-4 py-3 sm:border-b-0 sm:border-r">
                              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                {tr("synchronization")}
                              </p>
                              <div className="mt-1.5">
                                <Badge variant={syncStatus.variant}>
                                  {syncStatus.label}
                                </Badge>
                              </div>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {source.last_synced_at
                                  ? tr("lastSyncAt", { date: formatDateTime(source.last_synced_at) })
                                  : tr("noImport")}
                              </p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {source.auto_sync !== false
                                  ? tr("automaticInterval", { count: source.sync_interval_min || 15 })
                                  : tr("automaticDisabled")}
                              </p>
                            </div>
                            <div className="px-4 py-3">
                              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                {tr("observedInventory")}
                              </p>
                              <div className="mt-1.5 flex items-baseline gap-2">
                                <span className="text-lg font-semibold tabular-nums">
                                  {source.record_count || 0}
                                </span>
                                <span className="text-sm text-muted-foreground">
                                  {tr("ipAddresses")}
                                </span>
                              </div>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {tr("sourceInventoryBreakdown", {
                                  imported: source.inventory_count || 0,
                                  outside: source.ignored_count || 0,
                                })}
                              </p>
                              <details className="mt-3 rounded-md border p-2 text-xs">
                                <summary className="cursor-pointer font-medium">{tr('syncDiagnostics')}</summary>
                                <div className="mt-2 space-y-2">
                                  <p>{tr('diagnosticScope', { scope: source.type === 'unifi' ? `UniFi site ${source.site || 'default'} · ${source.path || 'configured endpoint'}` : `pfSense ${source.path || 'configured endpoint'}` })}</p>
                                  <p>{source.last_status === 'failed' ? tr('diagnosticFailed') : !source.last_synced_at ? tr('noImport') : !source.record_count ? tr('diagnosticEmpty') : tr('diagnosticCounts', { total: source.record_count, imported: source.inventory_count || 0, outside: source.ignored_count || 0 })}</p>
                                  <p>{!source.record_count ? tr('diagnosticEmptyChecks') : source.ignored_count ? tr('diagnosticOutside') : tr('diagnosticCompare')}</p>
                                  <p>{tr('diagnosticCompleteness')}</p>
                                </div>
                              </details>
                              <div className="mt-1">
                                {source.conflict_count ? (
                                  <Badge variant="destructive">
                                    {tr("conflictCount", { count: source.conflict_count })}
                                  </Badge>
                                ) : (
                                  <Badge variant="secondary">
                                    {tr("noConflicts")}
                                  </Badge>
                                )}
                              </div>
                            </div>
                          </div>
                        </section>
                      );
                    })}
                  </div>
                )}
                {sources.length === 0 && !creating && (
                  <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
                    {tr("noSources")}
                  </div>
                )}
              </>
            )}
            {canEdit && (creating ? (
              <form
                className="space-y-4 rounded-md border bg-muted/15 p-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  save.mutate();
                }}
              >
                <div>
                  <div>
                    <h3 className="text-sm font-semibold">
                      {editingSource
                        ? tr("editSource")
                        : tr("addSource")}
                    </h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {editingSource
                        ? tr("tokenKeepHint")
                        : tr("credentialsHint")}
                    </p>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={tr("system")}>
                    <select
                      value={type}
                      onChange={(event) =>
                        setType(event.target.value as "unifi" | "pfsense")
                      }
                      className="h-8 w-full rounded-sm border bg-background px-2.5 text-[13px]"
                    >
                      <option value="unifi">{tr("unifiNetwork")}</option>
                      <option value="pfsense">{tr("pfsense")}</option>
                    </select>
                  </Field>
                  <Field label={tr("displayName")}>
                    <Input
                      required
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder={
                        type === "pfsense"
                          ? tr("pfsenseProductionExample")
                          : tr("unifiProductionExample")
                      }
                    />
                  </Field>
                  <div className="sm:col-span-2">
                    <Field label={tr("controllerUrl")}>
                      <Input
                        required
                        type="url"
                        value={endpoint}
                        onChange={(event) => setEndpoint(event.target.value)}
                        placeholder={endpointPlaceholder}
                      />
                    </Field>
                  </div>
                  {type === "pfsense" && (
                    <div className="sm:col-span-2 rounded-md border bg-background p-3 text-xs text-muted-foreground">
                      <p className="font-medium text-foreground">{tr("pfsenseSetupTitle")}</p>
                      <ol className="mt-1.5 list-decimal space-y-1 pl-4">
                        <li>{tr("pfsenseSetupInstall")}</li>
                        <li>{tr("pfsenseSetupKey")}</li>
                        <li>{tr("pfsenseSetupAccess")}</li>
                      </ol>
                      <p className="mt-2">{tr("pfsenseReadOnlyHint")}</p>
                      <p className="mt-2">
                        <a
                          className="underline underline-offset-2 hover:text-foreground"
                          href="https://pfrest.org/INSTALL_AND_CONFIG/"
                          target="_blank"
                          rel="noreferrer"
                        >
                          {tr("pfsenseInstallDocs")}
                        </a>
                        {" · "}
                        <a
                          className="underline underline-offset-2 hover:text-foreground"
                          href="https://pfrest.org/AUTHENTICATION_AND_AUTHORIZATION/"
                          target="_blank"
                          rel="noreferrer"
                        >
                          {tr("pfsenseAuthDocs")}
                        </a>
                      </p>
                    </div>
                  )}
                  <Field
                    label={editingSource ? tr("apiTokenOptional") : tr("apiToken")}
                  >
                    <Input
                      required={!editingSource}
                      type="password"
                      autoComplete="new-password"
                      value={token}
                      onChange={(event) => setToken(event.target.value)}
                    />
                  </Field>
                  {type === "unifi" && (
                    <Field label={tr("unifiSite")}>
                      <Input
                        value={site}
                        onChange={(event) => setSite(event.target.value)}
                        placeholder={tr("defaultSitePlaceholder")}
                      />
                    </Field>
                  )}
                  <div className="sm:col-span-2">
                    <details>
                      <summary className="cursor-pointer text-sm text-muted-foreground">
                        {tr("advancedConnection")}
                      </summary>
                      <div className="mt-3 grid gap-3 border-t pt-3 sm:grid-cols-2">
                        <Field label={tr("apiPath")}>
                          <Input
                            value={path}
                            onChange={(event) => setPath(event.target.value)}
                            placeholder={defaultPath}
                          />
                        </Field>
                        <label className="flex items-center gap-2 self-end text-sm">
                          <input
                            type="checkbox"
                            checked={insecure}
                            onChange={(event) =>
                              setInsecure(event.target.checked)
                            }
                          />
                          {tr("skipTls")}
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={enabled}
                            onChange={(event) =>
                              setEnabled(event.target.checked)
                            }
                          />
                          {tr("sourceActive")}
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={autoSync}
                            onChange={(event) =>
                              setAutoSync(event.target.checked)
                            }
                          />
                          {tr("autoSync")}
                        </label>
                        <Field label={tr("syncInterval")}>
                          <Input
                            type="number"
                            min="5"
                            max="1440"
                            disabled={!autoSync}
                            value={syncInterval}
                            onChange={(event) =>
                              setSyncInterval(event.target.value)
                            }
                          />
                        </Field>
                      </div>
                    </details>
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={resetForm}>
                    {tr("cancel")}
                  </Button>
                  {save.error && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
                  <Button type="submit" disabled={save.isPending}>
                    <Settings2 />
                    {editingSource
                      ? tr("updateSource")
                      : tr("saveSource")}
                  </Button>
                </div>
              </form>
            ) : (
              <Button type="button" variant="outline" onClick={beginCreate}>
                <Plus />
                {tr("addSource")}
              </Button>
            ))}
          </div>
          {!embedded && (
            <DialogFooter className="border-t px-5 py-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                {tr("close")}
              </Button>
            </DialogFooter>
          )}
    </>
  );
  return (
    <>
      {embedded ? (
        <div data-ipam-sources className="min-w-0">{content}</div>
      ) : (
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent className="max-h-[calc(100dvh-2rem)] min-w-0 max-w-3xl overflow-x-hidden overflow-y-auto p-0">
            {content}
          </DialogContent>
        </Dialog>
      )}
      <ConfirmDialog
        open={Boolean(sourceToSync)}
        targetEnvironmentId={environmentId}
        closeOnConfirm={false}
        error={sync.error?.message}
        onOpenChange={(nextOpen) => !nextOpen && setSourceToSync(null)}
        title={tr("confirmSyncTitle")}
        description={sourceToSync ? tr("confirmSyncDescription", { name: sourceToSync.name }) : ""}
        confirmLabel={tr("syncNow")}
        cancelLabel={tr("cancel")}
        variant="warning"
        onConfirm={() => sourceToSync && sync.mutate(sourceToSync.id)}
        isPending={sync.isPending}
      />
      <ConfirmDialog
        open={Boolean(sourceToRemove)}
        targetEnvironmentId={environmentId}
        closeOnConfirm={false}
        error={remove.error?.message}
        onOpenChange={(nextOpen) => !nextOpen && setSourceToRemove(null)}
        title={tr("confirmRemoveSource")}
        description={sourceToRemove ? tr("confirmRemoveSourceDescription", {
          name: sourceToRemove.name,
          count: sourceToRemove.inventory_count || 0,
        }) : ""}
        confirmLabel={tr("removeSource")}
        cancelLabel={tr("cancel")}
        variant="destructive"
        onConfirm={() => sourceToRemove && remove.mutate(sourceToRemove.id)}
        isPending={remove.isPending}
      />
      <Dialog
        open={Boolean(testReport)}
        onOpenChange={(nextOpen) => !nextOpen && setTestReport(null)}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{tr("sourceChecked")}</DialogTitle>
            <DialogDescription>
              {testReport && (
                tr("sourceReachable", { name: testReport.source.name })
              )}
            </DialogDescription>
          </DialogHeader>
          {testReport && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 overflow-hidden rounded-md border">
                <SourceTestFact
                  label={tr("detected")}
                  value={testReport.result.records}
                />
                <SourceTestFact
                  label={tr("inIpam")}
                  value={testReport.result.matching_prefixes}
                />
                <SourceTestFact
                  label={tr("outside")}
                  value={testReport.result.outside_prefixes}
                />
              </div>
              {testReport.result.outside_prefixes > 0 && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                  {tr("outsidePrefixWarning")}
                </div>
              )}
              {testReport.result.samples?.length ? (
                <div className="rounded-md border">
                  <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
                    {tr("sampleLeases")}
                  </div>
                  <ul className="divide-y">
                    {testReport.result.samples
                      .slice(0, 3)
                      .map((sample, index) => (
                        <li
                          key={`${sample.address || "unknown"}-${index}`}
                          className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                        >
                          <span className="font-mono">
                            {sample.address || "—"}
                          </span>
                          <span className="min-w-0 text-right text-muted-foreground">
                            <span className="block truncate">
                              {sample.hostname || tr("noHostname")}
                            </span>
                            {sample.mac_address && (
                              <span className="block truncate font-mono text-xs">
                                {sample.mac_address}
                              </span>
                            )}
                          </span>
                        </li>
                      ))}
                  </ul>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {tr("noUsableLeases")}
                </p>
              )}
              <p className="text-xs leading-relaxed text-muted-foreground">
                {tr("reviewSyncHint")}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button type="button" onClick={() => setTestReport(null)}>
              {tr("done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function SourceTestFact({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-r px-3 py-2.5 last:border-r-0">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-mono text-lg font-semibold tabular-nums">
        {value}
      </div>
    </div>
  );
}
