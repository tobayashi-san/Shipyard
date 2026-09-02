import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import {
  Download,
  ScrollText,
  RotateCw,
  ClipboardList,
  Settings2,
} from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { SkeletonRow } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorState } from "@/components/ui/query-error-state";
import { TablePagination } from "@/components/ui/table-pagination";
import { ActiveFilterChips } from "@/components/ui/filter-chips";
import { DateTextInput } from "@/components/ui/date-input";
import { normalizeAuditIp, parseAuditDetail } from "@/lib/audit-display";
import { asArray, formatDateTime } from "@/lib/utils";
import { SettingsSection } from "@/routes/settings/_row";
import { useUi } from "@/lib/store";

interface AuditMeta {
  actions?: string[];
  users?: string[];
  count?: number;
}
interface AuditRow {
  action?: string;
  user?: string;
  detail?: string;
  ip?: string;
  success?: 0 | 1 | boolean;
  created_at?: string;
  object_links?: Array<{
    kind: "server" | "deployment" | "network";
    id: string;
    label: string;
    href: string;
  }>;
}

interface Filters {
  action: string;
  user: string;
  success: "" | "0" | "1";
  from: string;
  to: string;
}

const AUDIT_PAGE_SIZE = 25;

const initialFilters: Filters = {
  action: "",
  user: "",
  success: "",
  from: "",
  to: "",
};

function buildFilterParams(filters: Filters): Record<string, string> {
  const out: Record<string, string> = {};
  if (filters.action) out.action = filters.action;
  if (filters.user) out.user = filters.user;
  if (filters.success !== "") out.success = filters.success;
  if (filters.from) out.from = filters.from;
  if (filters.to) out.to = filters.to;
  return out;
}

export function AuditLogPanel() {
  const { t } = useTranslation();
  const environmentId = useUi((state) => state.environmentId);
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [page, setPage] = useState(1);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [focus, setFocus] = useState<"changes" | "all">("changes");
  const filterParams = { ...buildFilterParams(filters), focus };

  const metaQ = useQuery<AuditMeta>({
    queryKey: [
      "audit-meta",
      environmentId,
      filters.action,
      filters.user,
      filters.success,
      filters.from,
      filters.to,
      focus,
    ],
    queryFn: () =>
      api.getAuditMeta({ ...filterParams, environment_id: environmentId }) as unknown as Promise<AuditMeta>,
    staleTime: 60_000,
  });

  const rowsQ = useQuery<AuditRow[]>({
    queryKey: [
      "audit-log",
      environmentId,
      filters.action,
      filters.user,
      filters.success,
      filters.from,
      filters.to,
      focus,
      page,
    ],
    queryFn: () =>
      api.getAuditLog({
        ...filterParams,
        environment_id: environmentId,
        limit: AUDIT_PAGE_SIZE,
        offset: (page - 1) * AUDIT_PAGE_SIZE,
      }) as unknown as Promise<AuditRow[]>,
  });

  const resetAndSet = (patch: Partial<Filters>) => {
    setPage(1);
    setFilters((current) => ({ ...current, ...patch }));
  };

  const meta = metaQ.data || { actions: [], users: [], count: 0 };
  const rows = asArray<AuditRow>(rowsQ.data);
  const total = meta.count || 0;
  const totalPages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));
  const activeFilters = [
    ...(filters.action ? [{ id: "action", label: `${t("set.auditFilterAction")}: ${filters.action}`, onRemove: () => resetAndSet({ action: "" }) }] : []),
    ...(filters.user ? [{ id: "user", label: `${t("set.auditFilterUser")}: ${filters.user}`, onRemove: () => resetAndSet({ user: "" }) }] : []),
    ...(filters.success ? [{ id: "success", label: `${t("set.auditFilterStatus")}: ${filters.success === "1" ? t("set.auditStatusOk") : t("set.auditStatusFailed")}`, onRemove: () => resetAndSet({ success: "" }) }] : []),
    ...(filters.from ? [{ id: "from", label: `${t("set.auditFilterFrom")}: ${filters.from}`, onRemove: () => resetAndSet({ from: "" }) }] : []),
    ...(filters.to ? [{ id: "to", label: `${t("set.auditFilterTo")}: ${filters.to}`, onRemove: () => resetAndSet({ to: "" }) }] : []),
  ];

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    setPage(1);
  }, [environmentId]);

  return (
    <SettingsSection
      icon={<ScrollText className="h-4 w-4" />}
      title={t("set.auditTitle")}
    >
      <div className="console-toolbar border-b border-border/70 px-0 py-2">
        <div>
          <span className="text-xs text-muted-foreground">
            {metaQ.isError
              ? "Audit metadata unavailable"
              : t("set.auditTotal", { n: meta.count || 0 })} ·{" "}
            {t("set.auditRetention")}
          </span>
          <div className="mt-1 flex rounded-md border p-0.5" aria-label="Audit event focus">
            <Button size="sm" variant={focus === "changes" ? "secondary" : "ghost"} className="h-7" onClick={() => { setFocus("changes"); setPage(1); }}>
              Security & changes
            </Button>
            <Button size="sm" variant={focus === "all" ? "secondary" : "ghost"} className="h-7" onClick={() => { setFocus("all"); setPage(1); }}>
              All events
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant={filtersOpen ? "secondary" : "outline"}
            size="sm"
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <Settings2 className="h-4 w-4" />
            Filter
            {Object.values(filters).some((value) => value !== "")
              ? ": active"
              : ""}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void api.exportAuditLog(filterParams)}
          >
            <Download className="h-4 w-4" />
            Export
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void rowsQ.refetch();
              void metaQ.refetch();
            }}
          >
            <RotateCw className="h-4 w-4" />
            {t("set.auditRefresh")}
          </Button>
        </div>
      </div>

      {metaQ.isError && (
        <QueryErrorState
          compact
          error={metaQ.error}
          onRetry={() => {
            void metaQ.refetch();
          }}
          title="Audit filters could not be loaded"
        />
      )}

      {filtersOpen && (
        <div className="grid gap-2 border-b border-border/70 bg-muted/10 p-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label={t("set.auditFilterAction")}>
            <SelectInput
              ariaLabel={t("set.auditFilterAction")}
              value={filters.action}
              onChange={(v) => resetAndSet({ action: v })}
            >
              <option value="">{t("set.auditFilterAll")}</option>
              {asArray<string>(meta.actions).map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field label={t("set.auditFilterUser")}>
            <SelectInput
              ariaLabel={t("set.auditFilterUser")}
              value={filters.user}
              onChange={(v) => resetAndSet({ user: v })}
            >
              <option value="">{t("set.auditFilterAll")}</option>
              {asArray<string>(meta.users).map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field label={t("set.auditFilterStatus")}>
            <SelectInput
              ariaLabel={t("set.auditFilterStatus")}
              value={filters.success}
              onChange={(v) =>
                resetAndSet({ success: v as Filters["success"] })
              }
            >
              <option value="">{t("set.auditFilterAll")}</option>
              <option value="1">{t("set.auditStatusOk")}</option>
              <option value="0">{t("set.auditStatusFailed")}</option>
            </SelectInput>
          </Field>
          <Field label={t("set.auditFilterFrom")}>
            <DateTextInput
              ariaLabel={t("set.auditFilterFrom")}
              value={filters.from}
              onChange={(value) => resetAndSet({ from: value })}
            />
          </Field>
          <Field label={t("set.auditFilterTo")}>
            <DateTextInput
              ariaLabel={t("set.auditFilterTo")}
              value={filters.to}
              onChange={(value) => resetAndSet({ to: value })}
            />
          </Field>
        </div>
      )}

      <ActiveFilterChips
        className="rounded-none border-x-0"
        filters={activeFilters}
        onClear={() => {
          setPage(1);
          setFilters(initialFilters);
        }}
        clearLabel={t("set.auditFilterReset")}
      />

      {rowsQ.isLoading ? (
        <div className="py-2">
          <SkeletonRow cols={4} />
          <SkeletonRow cols={4} />
          <SkeletonRow cols={4} />
          <SkeletonRow cols={4} />
        </div>
      ) : rowsQ.isError ? (
        <QueryErrorState
          compact
          error={rowsQ.error}
          onRetry={() => {
            void rowsQ.refetch();
          }}
          title="Audit log could not be loaded"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          compact
          icon={<ClipboardList className="h-5 w-5" />}
          title={t("set.auditEmpty")}
        />
      ) : (
        <div>
          <div className="divide-y md:hidden">
            {rows.map((r, i) => (
              <AuditMobileRow
                key={`${r.created_at ?? ""}-${r.action ?? ""}-${r.user ?? ""}-${i}`}
                row={r}
              />
            ))}
          </div>
          <div className="table-scroll hidden md:block">
            <table
              data-density="compact"
              className="w-full min-w-[880px] text-sm"
            >
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Details</th>
                  <th>Triggered by</th>
                  <th>Object</th>
                  <th>Time</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <AuditTableRow
                    key={`${r.created_at ?? ""}-${r.action ?? ""}-${r.user ?? ""}-${i}`}
                    row={r}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {!metaQ.isError && (
            <TablePagination
              page={page}
              pageSize={AUDIT_PAGE_SIZE}
              totalItems={total}
              onPageChange={setPage}
              disabled={rowsQ.isFetching}
              itemLabel="audit entries"
            />
          )}
        </div>
      )}
    </SettingsSection>
  );
}

function auditObjectLabel(link: NonNullable<AuditRow["object_links"]>[number]) {
  if (link.kind === "deployment") return "Deployment: ";
  if (link.kind === "network") return "Prefix: ";
  return "Host: ";
}

function AuditTableRow({ row }: { row: AuditRow }) {
  const link = row.object_links?.[0];
  return (
    <tr>
      <td className="font-mono text-xs font-medium">{row.action || "—"}</td>
      <td className="max-w-[28rem]">
        <AuditDetail detail={row.detail} />
      </td>
      <td>
        <div className="text-sm">{row.user || "System"}</div>
        <AuditIp ip={row.ip} />
      </td>
      <td>
        {link ? (
          <a
            href={link.href}
            className="text-xs font-medium text-primary hover:underline"
          >
            {auditObjectLabel(link)}
            {link.label}
          </a>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="whitespace-nowrap font-mono text-xs text-muted-foreground">
        {formatDateTime(row.created_at)}
      </td>
      <td>
        <StatusBadge tone={row.success ? "success" : "danger"} dot>
          {row.success ? "Successful" : "Failed"}
        </StatusBadge>
      </td>
    </tr>
  );
}

function AuditMobileRow({ row }: { row: AuditRow }) {
  const link = row.object_links?.[0];
  return (
    <div className="space-y-2 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-mono text-xs font-medium">
            {row.action || "—"}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            <AuditDetail detail={row.detail} />
          </div>
        </div>
        <StatusBadge tone={row.success ? "success" : "danger"} dot>
          {row.success ? "OK" : "Failed"}
        </StatusBadge>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{row.user || "System"}</span>
        <AuditIp ip={row.ip} />
        <span>{formatDateTime(row.created_at)}</span>
      </div>
      {link && (
        <a
          href={link.href}
          className="block truncate text-xs font-medium text-primary hover:underline"
        >
          {auditObjectLabel(link)}
          {link.label}
        </a>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function SelectInput({
  value,
  onChange,
  children,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
  ariaLabel: string;
}) {
  return (
    <select
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs sm:w-auto sm:min-w-[110px]"
    >
      {children}
    </select>
  );
}

function AuditIp({ ip }: { ip?: string }) {
  const normalized = normalizeAuditIp(ip);
  if (!ip) return <span className="font-mono text-[11px] text-muted-foreground">—</span>;
  if (normalized === ip) {
    return <span className="font-mono text-[11px] text-muted-foreground">{ip}</span>;
  }
  return (
    <details className="text-[11px] text-muted-foreground">
      <summary className="cursor-pointer font-mono text-foreground">{normalized}</summary>
      <div className="mt-0.5">Raw IP: <code>{ip}</code></div>
    </details>
  );
}

function AuditDetail({ detail }: { detail?: string }) {
  const parsed = parseAuditDetail(detail);
  if (!parsed.raw) return <span>—</span>;
  if (parsed.fields.length === 0) {
    return <span className="block truncate" title={parsed.raw}>{parsed.raw}</span>;
  }
  return (
    <div className="min-w-0 space-y-1.5">
      {parsed.summary && <p className="text-xs text-foreground">{parsed.summary}</p>}
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11px]">
        {parsed.fields.map((field, index) => (
          <div className="contents" key={`${field.key}-${index}`}>
            <dt>{field.label}</dt>
            <dd className="break-all font-mono text-foreground">{field.value}</dd>
          </div>
        ))}
      </dl>
      <details>
        <summary className="cursor-pointer text-[11px] text-primary">Raw details</summary>
        <code className="mt-1 block break-all text-[11px]">{parsed.raw}</code>
      </details>
    </div>
  );
}
