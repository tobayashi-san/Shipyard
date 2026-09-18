import { Button } from '@/components/ui/button';
import { OverflowItem, OverflowMenu } from '@/components/ui/overflow-menu';
import { PageHeader } from '@/components/ui/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { hasCap, useProfile } from '@/lib/queries';
import { useUrlTab } from '@/lib/use-url-tab';
import { GitTab } from '@/routes/settings/tabs/git';
import { Link, useLocation } from '@tanstack/react-router';
import { Clock, FileText, GitBranch, Play, Plus, SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RunsTab } from './PlaybookRuns';
import { SchedulesTab } from './PlaybookSchedules';
import { TemplatesTab } from './PlaybookTemplates';
import { VarsTab } from './PlaybookVariables';

export function PlaybooksPage() {
  const { t } = useTranslation();
  const { data: profile } = useProfile();
  const location = useLocation();
  const requestedFile = new URLSearchParams(location.searchStr).get("file") || undefined;
  const isAdmin = profile?.role === "admin";
  const [runPreset, setRunPreset] = useState("");
  const [createRequest, setCreateRequest] = useState(0);
  const [createContext, setCreateContext] = useState<string | undefined>();
  const nextCreateRequest = useRef(0);
  const consumeCreateRequest = useCallback(() => setCreateRequest(0), []);

  const tabs = useMemo<{
    value: string;
    label: string;
    icon: React.ReactNode;
    cap?: string;
  }[]>(() => [
    {
      value: "templates",
      label: "Playbooks",
      icon: <FileText className="h-4 w-4" />,
    },
    {
      value: "runs",
      label: "Run automation",
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
    ...(isAdmin ? [{value:"git",label:"Git",icon:<GitBranch className="h-4 w-4"/>}] : []),
  ], [t,isAdmin]);
  const allowed = useMemo(() => tabs.filter((tb) => !tb.cap || hasCap(profile, tb.cap)), [profile, tabs]);
  const allowedValues = useMemo(() => allowed.map((item) => item.value), [allowed]);
  const playbookTabs = useUrlTab(hasCap(profile, "canRunPlaybooks") || hasCap(profile, "canAddSchedules") ? "runs" : "templates", allowedValues);

  // Ensure tab is still allowed after profile changes
  useEffect(() => {
    if (!allowed.find((a) => a.value === playbookTabs.value))
      playbookTabs.onValueChange(allowed[0]?.value ?? "templates");
  }, [allowedValues, playbookTabs.value, playbookTabs.onValueChange]);

  return (
    <div className="space-y-5">
      {/* Header + Git widget */}
      <PageHeader
        title={t("pb.title")}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">

            {playbookTabs.value === "templates" && hasCap(profile, "canEditPlaybooks") && (
              <Button onClick={() => { playbookTabs.onValueChange("templates"); setCreateContext(requestedFile); setCreateRequest(++nextCreateRequest.current); }}>
                <Plus />{t("pb.new")}
              </Button>
            )}
          </div>
        }
      />

      <Tabs value={playbookTabs.value} onValueChange={playbookTabs.onValueChange}>
        <TabsList className="console-tabs">
          {[...allowed].sort((a, b) => Number(b.value === "runs") - Number(a.value === "runs")).filter(tb => !["vars", "git"].includes(tb.value)).map((tb) => (
            <TabsTrigger key={tb.value} value={tb.value} className="gap-1.5">
              {tb.icon} {tb.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="flex items-center justify-end gap-2">
          <Button variant="link" asChild><Link to="/operations">View jobs</Link></Button>
          <OverflowMenu title="Advanced automation settings">
            {allowed.filter(tb => ['vars', 'git'].includes(tb.value)).map(tb => <OverflowItem key={tb.value} onClick={() => playbookTabs.onValueChange(tb.value)}>{tb.label}</OverflowItem>)}
          </OverflowMenu>
        </div>

        {isAdmin && <TabsContent value="git"><GitTab workspace /></TabsContent>}
        <TabsContent value="templates">
          <TemplatesTab key={requestedFile || "library"} initialFile={requestedFile} createRequest={createContext === requestedFile ? createRequest : 0} onCreateRequestHandled={consumeCreateRequest} onRun={(filename) => { setRunPreset(filename); playbookTabs.onValueChange("runs"); }} />
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
