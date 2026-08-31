import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Key,
  Copy,
  Download,
  Upload,
  Send,
  CheckCircle2,
  XCircle,
  Link2,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api";
import { useUi } from "@/lib/store";
import { showToast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { QueryErrorState } from "@/components/ui/query-error-state";
import { SettingsRow, SettingsSection } from "../_row";

interface SSHKey {
  publicKey: string;
  exists?: boolean;
  name?: string;
}

interface KeyAssignment {
  id: string;
  target_type: "server" | "deployment" | "vm_template";
  target_id: string;
  target_label: string;
}
interface KeyAssignmentTargets {
  servers: Array<{ id: string; label: string }>;
  deployments: Array<{ id: string; label: string }>;
  vm_templates: Array<{ id: string; label: string }>;
}

export function SshTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const environmentId = useUi((state) => state.environmentId);

  const { data, isLoading, isError } = useQuery<SSHKey | null>({
    queryKey: ["ssh-key"],
    queryFn: () => api.getSSHKey() as Promise<SSHKey>,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["ssh-key"] });

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={<Key className="h-4 w-4" />}
        title={t("set.sshTitle")}
      >
        {isLoading ? (
          <SettingsRow label={t("set.sshStatus")} noBorder>
            <Skeleton className="h-4 w-32" />
          </SettingsRow>
        ) : isError ? (
          <QueryErrorState compact title="SSH key status could not be loaded" onRetry={() => void refresh()} />
        ) : data && data.publicKey ? (
          <SshKeyView ssh={data} onChanged={refresh} />
        ) : (
          <SshKeyMissing isError={isError} onChanged={refresh} />
        )}
      </SettingsSection>

      <SettingsSection
        icon={<Link2 className="h-4 w-4" />}
        title="Key assignments"
      >
        <KeyAssignments environmentId={environmentId} />
      </SettingsSection>

      <SettingsSection
        icon={<Send className="h-4 w-4" />}
        title={t("set.sshDistribute")}
      >
        <DeployForm />
      </SettingsSection>
    </div>
  );
}

function KeyAssignments({ environmentId }: { environmentId: string }) {
  const qc = useQueryClient();
  const [type, setType] = useState<KeyAssignment["target_type"]>("server");
  const [loadTargets, setLoadTargets] = useState(false);
  const assignments = useQuery<KeyAssignment[]>({
    queryKey: ["ssh-key-assignments", environmentId],
    queryFn: () =>
      api.getSSHKeyAssignments(environmentId) as Promise<KeyAssignment[]>,
  });
  const targets = useQuery<KeyAssignmentTargets>({
    queryKey: ["ssh-key-assignment-targets", environmentId],
    queryFn: () =>
      api.getSSHKeyAssignmentTargets(
        environmentId,
      ) as Promise<KeyAssignmentTargets>,
    enabled: loadTargets,
  });
  const choices =
    targets.data?.[
      type === "server"
        ? "servers"
        : type === "deployment"
          ? "deployments"
          : "vm_templates"
    ] || [];
  const [targetId, setTargetId] = useState("");
  const refresh = () => {
    void qc.invalidateQueries({
      queryKey: ["ssh-key-assignments", environmentId],
    });
  };
  const save = useMutation({
    mutationFn: () =>
      api.saveSSHKeyAssignment({
        environment_id: environmentId,
        target_type: type,
        target_id: targetId,
      }),
    onSuccess: () => {
      setTargetId("");
      refresh();
      showToast("Key assignment saved.", "success");
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSSHKeyAssignment(id),
    onSuccess: refresh,
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const labels: Record<KeyAssignment["target_type"], string> = {
    server: "Host",
    deployment: "Deployment",
    vm_template: "VM template",
  };

  return (
    <div className="space-y-3 py-3.5">
      <p className="text-sm text-muted-foreground">
        Define which resources should use the central Shipyard key. Private keys
        are not duplicated.
      </p>
      <div className="grid gap-2 sm:grid-cols-[150px_minmax(0,1fr)_auto]">
        <select
          value={type}
          onChange={(event) => {
            setType(event.target.value as KeyAssignment["target_type"]);
            setTargetId("");
          }}
          className="h-9 rounded-sm border border-input bg-background px-2.5 text-[13px]"
          aria-label="Target type"
        >
          <option value="server">Host</option>
          <option value="deployment">Deployment</option>
          <option value="vm_template">VM template</option>
        </select>
        <select
          value={targetId}
          onFocus={() => setLoadTargets(true)}
          onChange={(event) => setTargetId(event.target.value)}
          className="h-9 min-w-0 rounded-sm border border-input bg-background px-2.5 text-[13px]"
          aria-label="Select target"
        >
          <option value="">
            {!loadTargets || targets.isLoading
              ? "Loading targets…"
              : targets.isError
                ? "Targets unavailable"
              : choices.length
                ? "Select target"
                : "No targets available"}
          </option>
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </select>
        <Button
          type="button"
          size="sm"
          className="h-9 px-3"
          onClick={() => save.mutate()}
          disabled={!targetId || save.isPending}
        >
          Assign
        </Button>
      </div>
      {loadTargets && targets.isError && (
        <QueryErrorState
          compact
          className="py-3"
          error={targets.error}
          title="Assignment targets could not be loaded"
          onRetry={() => void targets.refetch()}
        />
      )}
      {assignments.isLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : assignments.isError ? (
        <QueryErrorState
          compact
          error={assignments.error}
          title="Key assignments could not be loaded"
          onRetry={() => void assignments.refetch()}
        />
      ) : assignments.data?.length ? (
        <div className="divide-y rounded-md border">
          {assignments.data.map((assignment) => (
            <div
              className="flex items-center gap-3 px-3 py-2"
              key={assignment.id}
            >
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {assignment.target_label}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {labels[assignment.target_type]}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => remove.mutate(assignment.id)}
                disabled={remove.isPending}
                aria-label={`Remove ${assignment.target_label}`}
              >
                <Trash2 className="h-3.5 w-3.5" /> Remove
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-md border border-dashed px-3 py-3 text-sm text-muted-foreground">
          No resources assigned yet.
        </p>
      )}
    </div>
  );
}

function SshKeyView({
  ssh,
  onChanged,
}: {
  ssh: SSHKey;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const escapedKey = ssh.publicKey.replace(/'/g, "'\\''");
  const installCmd = `mkdir -p ~/.ssh && echo '${escapedKey}' >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`;
  const [exportOpen, setExportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);

  const copy = (text: string, msg: string) => {
    navigator.clipboard.writeText(text).then(() => showToast(msg, "success"));
  };

  const onPickImport = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      setImportFile(file);
    };
    input.click();
  };

  return (
    <>
      <SettingsRow label={t("set.sshName")}>
        <span className="font-mono text-sm">{ssh.name || "shipyard"}</span>
      </SettingsRow>
      <SettingsRow label={t("set.sshType")}>
        <span className="font-mono text-sm">ED25519</span>
      </SettingsRow>
      <SettingsRow label={t("set.sshStatus")}>
        {ssh.exists !== false ? (
          <StatusBadge tone="success">
            <CheckCircle2 className="h-3 w-3" /> {t("set.sshActive")}
          </StatusBadge>
        ) : (
          <StatusBadge tone="muted">
            <XCircle className="h-3 w-3" /> {t("set.sshNotFound")}
          </StatusBadge>
        )}
      </SettingsRow>

      <SettingsRow label={t("set.sshPublicKey")} align="start">
        <div className="w-full min-w-0 rounded-md border bg-muted/40 p-3">
          <div className="font-mono text-xs leading-relaxed break-all">
            {ssh.publicKey}
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() => copy(ssh.publicKey, t("set.keyCopied"))}
          >
            <Copy className="h-3.5 w-3.5" /> {t("common.copy")}
          </Button>
        </div>
      </SettingsRow>

      <SettingsRow
        label={t("set.sshManualAdd")}
        hint={t("set.sshManualHint")}
        align="start"
      >
        <div className="w-full min-w-0 rounded-md border bg-muted/40 p-3">
          <div className="font-mono text-xs leading-relaxed break-all">
            {installCmd}
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() => copy(installCmd, t("set.cmdCopied"))}
          >
            <Copy className="h-3.5 w-3.5" /> {t("common.copy")}
          </Button>
        </div>
      </SettingsRow>

      <SettingsRow
        label={t("set.manageKey")}
        hint={t("set.manageKeyHint")}
        noBorder
      >
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setExportOpen(true)}
        >
          <Download className="h-4 w-4" /> {t("set.exportKeyTitle")}
        </Button>
        <Button variant="secondary" size="sm" onClick={onPickImport}>
          <Upload className="h-4 w-4" /> {t("set.importKeyTitle")}
        </Button>
      </SettingsRow>

      <ExportKeyDialog open={exportOpen} onOpenChange={setExportOpen} />
      <ImportKeyDialog
        file={importFile}
        onClose={() => setImportFile(null)}
        onImported={() => {
          setImportFile(null);
          onChanged();
        }}
      />
    </>
  );
}

function SshKeyMissing({
  isError,
  onChanged,
}: {
  isError?: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);

  const generate = async () => {
    setBusy(true);
    try {
      await api.generateSSHKey("shipyard");
      showToast(t("set.sshGenerated"), "success");
      onChanged();
    } catch (err) {
      showToast(
        t("common.errorPrefix", { msg: (err as Error).message }),
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  const onPickImport = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      setImportFile(file);
    };
    input.click();
  };

  return (
    <>
      <SettingsRow label={t("set.sshStatus")} noBorder>
        <span className="text-sm text-muted-foreground">
          {isError ? t("common.error") : t("set.sshNone")}
        </span>
        <Button size="sm" onClick={generate} disabled={busy}>
          <Key className="h-4 w-4" /> {t("set.sshGenerate")}
        </Button>
        <Button variant="secondary" size="sm" onClick={onPickImport}>
          <Upload className="h-4 w-4" /> {t("set.importKeyTitle")}
        </Button>
      </SettingsRow>
      <ImportKeyDialog
        file={importFile}
        onClose={() => setImportFile(null)}
        onImported={() => {
          setImportFile(null);
          onChanged();
        }}
      />
    </>
  );
}

function ExportKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (pass !== pass2) {
      showToast(t("set.exportKeyMismatch"), "error");
      return;
    }
    setBusy(true);
    try {
      const res = (await api.exportSSHKey(pass)) as { privateKey: string };
      const blob = new Blob([res.privateKey], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "shipyard_id_ed25519";
      a.click();
      URL.revokeObjectURL(a.href);
      onOpenChange(false);
      setPass("");
      setPass2("");
    } catch (err) {
      showToast(
        t("common.errorPrefix", { msg: (err as Error).message }),
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }} className="contents">
        <DialogHeader>
          <DialogTitle>{t("set.exportKeyTitle")}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t("set.exportKeyHint")}
        </p>
        <Input
          aria-label={t("set.exportKeyPlaceholder")}
          name="exportKeyPassphrase"
          type="password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          placeholder={t("set.exportKeyPlaceholder")}
          autoComplete="new-password"
        />
        <Input
          aria-label={t("set.exportKeyConfirm")}
          name="exportKeyPassphraseConfirmation"
          type="password"
          value={pass2}
          onChange={(e) => setPass2(e.target.value)}
          placeholder={t("set.exportKeyConfirm")}
          autoComplete="new-password"
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={busy}>
            <Download className="h-4 w-4" /> {t("set.exportKeyBtn")}
          </Button>
        </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ImportKeyDialog({
  file,
  onClose,
  onImported,
}: {
  file: File | null;
  onClose: () => void;
  onImported: () => void;
}) {
  const { t } = useTranslation();
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    try {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      const content = await file.text();
      await api.importSSHKey(content, pass || "");
      showToast(t("set.importKeySuccess"), "success");
      setPass("");
      onImported();
    } catch (err) {
      showToast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={file !== null}
      onOpenChange={(v) => {
        if (!v) {
          setPass("");
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-sm" disableMotion>
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }} className="contents">
        <DialogHeader>
          <DialogTitle>{t("set.importKeyTitle")}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t("set.importKeyHint")}
        </p>
        {file && (
          <p
            className="truncate text-xs text-muted-foreground"
            title={file.name}
          >
            {file.name}
          </p>
        )}
        <Input
          aria-label={t("set.importKeyPlaceholder")}
          name="importKeyPassphrase"
          type="password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          placeholder={t("set.importKeyPlaceholder")}
          autoComplete="current-password"
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={busy}>
            <Upload className="h-4 w-4" /> {t("set.importKeyBtn")}
          </Button>
        </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeployForm() {
  const { t } = useTranslation();
  const environmentId = useUi((state) => state.environmentId);
  const [ip, setIp] = useState("");
  const [user, setUser] = useState("root");
  const [port, setPort] = useState("22");
  const [pw, setPw] = useState("");
  const [busyOne, setBusyOne] = useState(false);
  const [busyAll, setBusyAll] = useState(false);
  const [confirmOne, setConfirmOne] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const hostsQuery = useQuery<Array<{ id: string; name: string; ip_address?: string }>>({
    queryKey: ["servers", environmentId],
    queryFn: () => api.getServers(environmentId) as unknown as Promise<Array<{ id: string; name: string; ip_address?: string }>>,
    enabled: confirmAll,
  });
  const deployTargets = Array.isArray(hostsQuery.data) ? hostsQuery.data : [];

  const deployOne = async () => {
    setBusyOne(true);
    try {
      await api.deploySSHKey({
        ip_address: ip,
        ssh_user: user || "root",
        ssh_port: parseInt(port, 10) || 22,
        password: pw,
      });
      showToast(t("set.sshDistributed"), "success");
      setPw("");
      setConfirmOne(false);
    } catch (err) {
      showToast(
        t("common.errorPrefix", { msg: (err as Error).message }),
        "error",
      );
    } finally {
      setBusyOne(false);
    }
  };

  const deployAll = async () => {
    setBusyAll(true);
    try {
      const result = (await api.deploySSHKeyAll({ password: pw })) as {
        succeeded: number;
        failed: number;
      };
      showToast(
        t("set.sshDistributedAllResult", {
          succeeded: result.succeeded,
          failed: result.failed,
        }),
        result.failed ? "warning" : "success",
      );
      setPw("");
    } catch (err) {
      showToast(
        t("common.errorPrefix", { msg: (err as Error).message }),
        "error",
      );
    } finally {
      setBusyAll(false);
      setConfirmAll(false);
    }
  };

  return (
    <>
      <form onSubmit={(event) => { event.preventDefault(); if (ip) setConfirmOne(true); }} className="contents">
      <SettingsRow label={t("set.sshTarget")} hint={t("set.sshTargetHint")}>
        <div className="grid w-full max-w-md grid-cols-1 gap-2 sm:grid-cols-[1fr_90px_70px]">
          <Input
            aria-label="SSH host address"
            name="sshHost"
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            placeholder="192.168.1.100"
          />
          <Input
            aria-label="SSH username"
            name="sshUsername"
            autoComplete="username"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="root"
          />
          <Input
            aria-label="SSH port"
            name="sshPort"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            type="number"
            placeholder="22"
          />
        </div>
      </SettingsRow>

      <SettingsRow label={t("set.sshPassword")} hint={t("set.sshPasswordHint")}>
        <Input
          aria-label={t("set.sshPassword")}
          name="sshPassword"
          value={pw}
          type="password"
          onChange={(e) => setPw(e.target.value)}
          placeholder={t("set.serverPasswordPlaceholder")}
          autoComplete="new-password"
          className="max-w-md"
        />
      </SettingsRow>

      <SettingsRow label={null} hint={t("set.sshDistributeAllHint")} noBorder>
        <Button type="submit" size="sm" disabled={busyOne || !ip}>
          <Key className="h-4 w-4" />{" "}
          {busyOne ? t("set.deploying") : t("set.sshDistributeBtn")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            if (!pw) {
              showToast(t("set.passwordRequired"), "error");
              return;
            }
            setConfirmAll(true);
          }}
          disabled={busyAll}
        >
          <Key className="h-4 w-4" />{" "}
          {busyAll ? t("set.deploying") : t("set.sshDistributeAllBtn")}
        </Button>
      </SettingsRow>
      </form>

      <Dialog open={confirmOne} onOpenChange={setConfirmOne}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Install SSH key on this host?</DialogTitle>
          </DialogHeader>
          <div className="rounded-md border bg-muted/20 p-3 text-sm">
            <div className="font-medium">{user || "root"}@{ip}</div>
            <div className="mt-1 text-xs text-muted-foreground">Port {parseInt(port, 10) || 22} · the password is used only for this installation request.</div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmOne(false)}>{t("common.cancel")}</Button>
            <Button onClick={deployOne} disabled={busyOne || !ip}>{busyOne ? t("set.deploying") : t("set.sshDistributeBtn")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmAll} onOpenChange={setConfirmAll}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("set.sshDistributeAllBtn")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm">{t("set.sshDeployAllConfirm")}</p>
          <div className="max-h-48 overflow-y-auto rounded-md border bg-muted/20 p-2 text-sm">
            {hostsQuery.isLoading ? (
              <span className="text-muted-foreground">Loading target preview…</span>
            ) : hostsQuery.isError ? (
              <QueryErrorState
                compact
                className="py-3"
                error={hostsQuery.error}
                title="SSH deployment targets could not be loaded"
                onRetry={() => void hostsQuery.refetch()}
              />
            ) : deployTargets.length ? (
              <>
                <div className="mb-1 px-1 text-xs font-semibold text-muted-foreground">{deployTargets.length} hosts</div>
                {deployTargets.slice(0, 8).map((host) => <div key={host.id} className="flex justify-between gap-3 rounded-sm px-1 py-1"><span className="truncate">{host.name}</span><span className="font-mono text-xs text-muted-foreground">{host.ip_address || "—"}</span></div>)}
                {deployTargets.length > 8 && <div className="px-1 pt-1 text-xs text-muted-foreground">+{deployTargets.length - 8} more hosts</div>}
              </>
            ) : <span className="text-muted-foreground">No hosts in this environment.</span>}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmAll(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={deployAll}
              disabled={busyAll || hostsQuery.isLoading || deployTargets.length === 0}
            >
              {t("set.sshDistributeAllBtn")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
