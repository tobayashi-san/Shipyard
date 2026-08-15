import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FileText,
  Plus,
  Save,
  Trash2,
  Play,
  History,
  Search,
  ChevronDown,
  FolderCog,
  Folder,
  ArrowLeft,
  X,
  Eye,
  Undo2,
  Clock,
  SlidersHorizontal,
  GitBranch,
  ArrowDown,
  ArrowUp,
  Settings2,
  Terminal,
  KeyRound,
  Calendar,
  GitCommit,
} from "lucide-react";
import { api } from "@/lib/api";
import { asArray } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { QueryErrorState } from "@/components/ui/query-error-state";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton, SkeletonRow } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useUi } from "@/lib/store";
import { useProfile, hasCap } from "@/lib/queries";
import { showToast } from "@/lib/toast";
import { ws } from "@/lib/ws";
import { useNavigate } from "@tanstack/react-router";
import {
  buildAllExceptTargets,
  cronToSelectors,
  formatDate as fmtDate,
  INTERVALS,
  loadCollapsedCategories as loadCollapsed,
  parsePlaybookTargets,
  saveCollapsedCategories as saveCollapsed,
  selectorsToCron,
  TEMPLATE_YAML,
  WEEKDAYS,
} from "./playbook-utils";

const PlaybookEditor = lazy(() => import("./components/PlaybookEditor"));
import type { AnsibleVar, HistoryEntry, Playbook, PlaybookVersion, Schedule } from "./playbook-types";
import { TemplatesTab } from "./PlaybookTemplates";
import { RunsTab } from "./PlaybookRuns";
import { VarsTab } from "./PlaybookVariables";
import { SchedulesTab } from "./PlaybookSchedules";
import { HistoryTab } from "./PlaybookHistory";

// ── Types ────────────────────────────────────────────────────────────────────



// ═════════════════════════════════════════════════════════════════════════════
// Main page
// ═════════════════════════════════════════════════════════════════════════════

export function PlaybooksPage() {
  const { t } = useTranslation();
  const { data: profile } = useProfile();
  const navigate = useNavigate();
  const isAdmin = profile?.role === "admin";
  const [runPreset, setRunPreset] = useState("");

  const tabs: {
    value: string;
    label: string;
    icon: React.ReactNode;
    cap?: string;
  }[] = [
    {
      value: "templates",
      label: "Playbooks",
      icon: <FileText className="h-4 w-4" />,
    },
    {
      value: "runs",
      label: "Runs",
      icon: <Play className="h-4 w-4" />,
    },
    {
      value: "vars",
      label: "Variables & Secrets",
      icon: <SlidersHorizontal className="h-4 w-4" />,
      cap: "canViewVars",
    },
    {
      value: "schedules",
      label: t("pb.tabSchedules"),
      icon: <Clock className="h-4 w-4" />,
      cap: "canViewSchedules",
    },
  ];
  const allowed = tabs.filter((tb) => !tb.cap || hasCap(profile, tb.cap));
  const [tab, setTab] = useState(allowed[0]?.value ?? "templates");

  // Ensure tab is still allowed after profile changes
  useEffect(() => {
    if (!allowed.find((a) => a.value === tab))
      setTab(allowed[0]?.value ?? "templates");
  }, [allowed, tab]);

  return (
    <div className="space-y-5">
      {/* Header + Git widget */}
      <PageHeader
        title={t("pb.title")}
        description={t("pb.subtitle")}
        actions={
          isAdmin ? (
            <GitWidget onGoSettings={() => navigate({ to: "/settings" })} />
          ) : undefined
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="console-tabs">
          {allowed.map((tb) => (
            <TabsTrigger key={tb.value} value={tb.value} className="gap-1.5">
              {tb.icon} {tb.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="templates">
          <TemplatesTab onRun={(filename) => { setRunPreset(filename); setTab("runs"); }} />
        </TabsContent>
        <TabsContent value="runs">
          <RunsTab initialPlaybook={runPreset} />
        </TabsContent>
        <TabsContent value="vars">
          <VarsTab />
        </TabsContent>
        <TabsContent value="schedules">
          <SchedulesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Git Widget
// ═════════════════════════════════════════════════════════════════════════════

function GitWidget({ onGoSettings }: { onGoSettings: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: cfg } = useQuery({
    queryKey: ["git-config"],
    queryFn: () => api.getGitConfig() as Promise<Record<string, unknown>>,
  });
  const branch = (cfg?.branch as string) || "main";
  const configured = !!cfg?.repoUrl;

  const pullMut = useMutation({
    mutationFn: () => api.gitPull(),
    onSuccess: () => {
      showToast(t("git.pulled"), "success");
      qc.invalidateQueries({ queryKey: ["playbooks"] });
    },
    onError: (e: Error) =>
      showToast(t("git.pullFailed", { msg: e.message }), "error"),
  });
  const pushMut = useMutation({
    mutationFn: () => api.gitPush(),
    onSuccess: () => showToast(t("git.pushed"), "success"),
    onError: (e: Error) =>
      showToast(t("git.pushFailed", { msg: e.message }), "error"),
  });

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
      <div className="flex min-w-0 max-w-[220px] items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground">
        <GitBranch className="h-3.5 w-3.5" />
        <span className="truncate">
          {configured ? branch : t("git.notConfigured")}
        </span>
      </div>
      <Button
        variant="outline"
        size="icon"
        className="h-7 w-7"
        onClick={() => pullMut.mutate()}
        disabled={pullMut.isPending}
        title={t("git.pullRemote")}
      >
        <ArrowDown className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="h-7 w-7"
        onClick={() => pushMut.mutate()}
        disabled={pushMut.isPending}
        title={t("git.pushRemote")}
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="h-7 w-7"
        onClick={onGoSettings}
        title={t("git.settings")}
      >
        <Settings2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Tab: Templates (split-pane: list + editor/run)
// ═════════════════════════════════════════════════════════════════════════════
