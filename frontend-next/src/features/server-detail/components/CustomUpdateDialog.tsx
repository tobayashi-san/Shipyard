import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { Textarea } from '@/components/ui/textarea';
import { hasCap } from '@/lib/queries';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ServerDetailController } from '../useServerDetailController';
import { CustomUpdatePreview } from './CustomUpdatePreview';
import { COMMUNITY_SCRIPT_SLUG, communityScriptTask } from '../custom-task-draft';

export function CustomUpdateDialog({ controller }: { controller: Pick<ServerDetailController, 't' | 'id' | 'profile' | 'taskDialog' | 'setTaskDialog' | 'taskForm' | 'setTaskForm' | 'saveTaskMut' | 'taskDirty' | 'taskContextChanged'> }) {
  const { t, id, profile, taskDialog, setTaskDialog, taskForm, setTaskForm, saveTaskMut, taskDirty, taskContextChanged } = controller;
  const { reset } = saveTaskMut;
  const [discardOpen, setDiscardOpen] = useState(false);
  const [scriptSlug, setScriptSlug] = useState('');
  const slugValid = COMMUNITY_SCRIPT_SLUG.test(scriptSlug.trim().toLowerCase());
  const requestClose = () => {
    if (saveTaskMut.isPending) return;
    if (taskDirty) setDiscardOpen(true);
    else setTaskDialog({ open: false, task: null });
  };
  useEffect(() => { if (taskDialog.open) reset(); }, [taskDialog.open, taskDialog.task?.id, reset]);
  const { data: snapshotTarget } = useQuery({ queryKey: ['server', id, 'customUpdateSnapshotTarget'], queryFn: () => api.getCustomUpdateSnapshotTarget(id), enabled: taskDialog.open });
  const canSnapshot = hasCap(profile, 'canEditServers');
  // A stored choice can always be switched off, even when the link is gone.
  const snapshotDisabled = !taskForm.snapshot_before_run && (!snapshotTarget?.available || !canSnapshot);
  const snapshotHint = snapshotTarget?.available
    ? `Fleet snapshots ${snapshotTarget.guest_type === 'lxc' ? 'CT' : 'VM'} ${snapshotTarget.vm_id} on ${snapshotTarget.node_name} (disk only) and runs the update only after Proxmox confirms it. The newest 3 automatic snapshots are kept; older ones starting with "fleet-pre-" are removed. Manual snapshots are not touched.${canSnapshot ? '' : ' Enabling this requires permission to edit hosts.'}`
    : 'Available when this host is linked to a Proxmox VM or container.';
  return (
    <>
      <Dialog
        open={taskDialog.open}
        onOpenChange={(v) => {
          if (!v) requestClose();
        }}
      >
        <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>
              {taskDialog.task ? t("det.editTask") : t("det.addTask")}
            </DialogTitle>
          </DialogHeader>
          <form id="custom-update-task-form" className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1" onSubmit={event => { event.preventDefault(); if (!taskContextChanged) saveTaskMut.mutate(); }}>
          <fieldset disabled={saveTaskMut.isPending} className="space-y-3">
            <p className="text-xs text-muted-foreground">{taskForm.type === 'trigger' ? 'An update is available when the check output exactly matches the trigger text after trimming surrounding whitespace. Comparison is case-sensitive.' : 'The command should print one version string; any change from the current version counts as an update.'}</p>
            <p className="text-xs text-muted-foreground">An installed-version/output command is required. Script checks also need a desired-version command. Changing a check rule clears previous results; run a new check after saving.</p>
            <details className="rounded-md border p-3" open={!taskDialog.task}>
              <summary className="cursor-pointer text-sm font-medium">Fill in for a Proxmox community script</summary>
              <p className="mt-2 text-xs text-muted-foreground">For apps installed with community-scripts/ProxmoxVE that are updated with <code>update</code>. Fleet reads the installed version from the host and compares it with the release the script currently installs, so an update only appears once the script supports it.</p>
              <div className="mt-2 flex gap-2">
                <Input aria-label="Community script name" placeholder="immich" value={scriptSlug} onChange={(e) => setScriptSlug(e.target.value)} className="max-w-xs font-mono" />
                <Button type="button" variant="outline" disabled={!slugValid} onClick={() => setTaskForm((f) => ({ ...f, ...communityScriptTask(scriptSlug, f.name) }))}>Fill in</Button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">The name from the script URL, e.g. <code>immich</code> for ct/immich.sh.</p>
            </details>
            <div className="space-y-1">
              <Label htmlFor="custom-task-name">{t("det.taskName")}</Label>
              <Input
                id="custom-task-name"
                required maxLength={200}
                value={taskForm.name}
                onChange={(e) =>
                  setTaskForm((f) => ({ ...f, name: e.target.value }))
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="custom-task-type">{t("det.taskType")}</Label>
              <select
                id="custom-task-type"
                value={taskForm.type}
                onChange={(e) =>
                  setTaskForm((f) => ({ ...f, type: e.target.value }))
                }
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="script">{t("det.taskTypeScript")}</option>
                <option value="github">{t("det.taskTypeGithub")}</option>
                <option value="trigger">{t("det.taskTypeTrigger")}</option>
              </select>
              <p className="text-xs text-muted-foreground">
                {taskForm.type === "github"
                  ? t("det.taskTypeGithubDesc")
                  : taskForm.type === "trigger"
                    ? t("det.taskTypeTriggerDesc")
                    : t("det.taskTypeScriptDesc")}
              </p>
            </div>
            {taskForm.type === "github" && (
              <div className="space-y-1">
                <Label htmlFor="custom-task-github_repo">{t("det.taskGithubRepo")}</Label>
                <Input
                  id="custom-task-github_repo"
                required pattern="[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+"
                value={taskForm.github_repo}
                  onChange={(e) =>
                    setTaskForm((f) => ({ ...f, github_repo: e.target.value }))
                  }
                  placeholder="owner/repo"
                  className="font-mono"
                />
              </div>
            )}
            {taskForm.type === "trigger" && (
              <div className="space-y-1">
                <Label htmlFor="custom-task-trigger_output">{t("det.taskTriggerOutput")}</Label>
                <Input
                  id="custom-task-trigger_output"
                required maxLength={5000}
                value={taskForm.trigger_output}
                  onChange={(e) =>
                    setTaskForm((f) => ({
                      ...f,
                      trigger_output: e.target.value,
                    }))
                  }
                  placeholder="AVAILABLE"
                  className="font-mono"
                />
              </div>
            )}
            {taskForm.type === "script" && (
              <div className="space-y-1">
                <Label htmlFor="custom-task-latest_command">{t("det.taskLatestCommand")}</Label>
                <Textarea
                  rows={2} required maxLength={5000}
                  id="custom-task-latest_command"
                value={taskForm.latest_command}
                  onChange={(e) =>
                    setTaskForm((f) => ({
                      ...f,
                      latest_command: e.target.value,
                    }))
                  }
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  {t("det.taskLatestCommandHint")}
                </p>
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="custom-task-check_command">{t("det.taskCheckCommand")}</Label>
              <Textarea
                rows={2}
                maxLength={5000}
                required={true}
                id="custom-task-check_command"
                value={taskForm.check_command}
                onChange={(e) =>
                  setTaskForm((f) => ({ ...f, check_command: e.target.value }))
                }
                className="font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="custom-task-update_command">{t("det.taskUpdateCommand")}</Label>
              <Textarea
                rows={2}
                maxLength={5000}
                required={false}
                id="custom-task-update_command"
                value={taskForm.update_command}
                onChange={(e) =>
                  setTaskForm((f) => ({ ...f, update_command: e.target.value }))
                }
                className="font-mono"
              />
            </div>
            <div className="flex items-start justify-between gap-4 rounded-md border p-3">
              <div className="space-y-1">
                <Label htmlFor="custom-task-snapshot">Snapshot before update</Label>
                <p className="text-xs text-muted-foreground">{snapshotHint}</p>
              </div>
              <Switch
                id="custom-task-snapshot"
                checked={taskForm.snapshot_before_run}
                disabled={snapshotDisabled}
                onCheckedChange={(checked) => setTaskForm((f) => ({ ...f, snapshot_before_run: checked }))}
              />
            </div>
          </fieldset>
          {taskDialog.open && hasCap(profile, 'canRunCustomUpdates') && <CustomUpdatePreview serverId={id} draft={{...taskForm}} disabled={saveTaskMut.isPending || taskContextChanged} />}
          </form>
          {taskContextChanged && <p role="alert" className="text-sm text-destructive">Host or environment changed. Your draft is preserved; return to the original context or reopen this form.</p>}
          {taskDirty && <p className="text-xs text-muted-foreground">Unsaved changes</p>}
          {saveTaskMut.isError && <p role="alert" className="text-sm text-destructive">{saveTaskMut.error.message}</p>}
          <DialogFooter className="shrink-0 border-t pt-3">
            <Button
              variant="ghost"
              disabled={saveTaskMut.isPending}
              onClick={requestClose}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit" form="custom-update-task-form"
              disabled={saveTaskMut.isPending || taskContextChanged}
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={discardOpen} onOpenChange={setDiscardOpen} title="Discard custom update changes?" description="The unsaved task configuration will be lost." confirmLabel="Discard changes" cancelLabel="Keep editing" onConfirm={() => { setDiscardOpen(false); setTaskDialog({ open: false, task: null }); }} />
    </>

  );
}
