import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, Save, Settings2, SlidersHorizontal, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonRow } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { hasCap, useProfile } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { showToast } from "@/lib/toast";
import type { AnsibleVar } from "./playbook-types";

export function VarsTab() {
  const { t } = useTranslation();
  const { data: profile } = useProfile();
  const qc = useQueryClient();
  const environmentId = useUi((state) => state.environmentId);
  const { data: vars, isLoading } = useQuery<AnsibleVar[]>({
    queryKey: ["ansibleVars", environmentId],
    queryFn: () => api.getAnsibleVars(environmentId) as unknown as Promise<AnsibleVar[]>,
  });

  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [desc, setDesc] = useState("");
  const [isSecret, setIsSecret] = useState(false);
  const [deleteItem, setDeleteItem] = useState<AnsibleVar | null>(null);
  const plainVariables = (vars || []).filter((variable) => !variable.is_secret);
  const secretVariables = (vars || []).filter((variable) => variable.is_secret);

  const openNew = () => {
    setEditId(null);
    setKey("");
    setValue("");
    setDesc("");
    setIsSecret(false);
    setFormOpen(true);
  };
  const openEdit = (v: AnsibleVar) => {
    setEditId(v.id);
    setKey(v.key);
    setValue(v.is_secret ? "" : v.value);
    setDesc(v.description ?? "");
    setIsSecret(Boolean(v.is_secret));
    setFormOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!key.trim() || (!value && !(editId && isSecret))) throw new Error(t("common.error"));
      if (editId)
        return api.updateAnsibleVar(editId, { key, value, description: desc, is_secret: isSecret });
      return api.createAnsibleVar({ key, value, description: desc, is_secret: isSecret, environment_id: environmentId });
    },
    onSuccess: () => {
      showToast(t("vars.saved"), "success");
      setFormOpen(false);
      qc.invalidateQueries({ queryKey: ["ansibleVars", environmentId] });
    },
    onError: (e: Error) => showToast(e.message, "error"),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => api.deleteAnsibleVar(id),
    onSuccess: () => {
      showToast(t("vars.deleted"), "success");
      setDeleteItem(null);
      qc.invalidateQueries({ queryKey: ["ansibleVars", environmentId] });
    },
    onError: (e: Error) => showToast(e.message, "error"),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold">
                <SlidersHorizontal className="h-4 w-4" /> {t("vars.title")}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Scoped to environment <code className="rounded bg-muted px-1">{environmentId}</code>. Secrets are encrypted and always masked.
              </p>
            </div>
            {hasCap(profile, "canAddVars") && (
              <Button size="sm" onClick={openNew}>
                <Plus className="h-4 w-4" /> {t("vars.add")}
              </Button>
            )}
          </div>
          {isLoading ? (
            <div className="space-y-1">
              <SkeletonRow cols={4} />
              <SkeletonRow cols={4} />
              <SkeletonRow cols={4} />
              <SkeletonRow cols={4} />
            </div>
          ) : !vars || vars.length === 0 ? (
            <EmptyState
              compact
              icon={<KeyRound className="h-5 w-5" />}
              title={t("vars.noVars")}
            />
          ) : (
            <div className="table-scroll">
              <table className="w-full text-sm" data-density="compact">
                <thead>
                  <tr>
                    <th className="px-3">{t("vars.key")}</th>
                    <th className="px-3">{t("vars.value")}</th>
                    <th className="px-3">{t("vars.description")}</th>
                    <th className="w-20 px-3">
                      <span className="sr-only">{t("common.actions")}</span>
                    </th>
                  </tr>
                </thead>
                {[
                  { label: "Variables", description: "Plain values returned to authorized users", items: plainVariables },
                  { label: "Secrets", description: "Encrypted values; saved values cannot be revealed", items: secretVariables },
                ].map((group) => (
                  <tbody key={group.label}>
                    <tr className="bg-muted/35">
                      <td colSpan={4} className="px-3 py-2">
                        <span className="font-medium">{group.label}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{group.items.length} · {group.description}</span>
                      </td>
                    </tr>
                    {group.items.length === 0 ? (
                      <tr><td colSpan={4} className="px-3 py-3 text-xs text-muted-foreground">No {group.label.toLowerCase()} configured.</td></tr>
                    ) : group.items.map((v) => (
                      <tr key={v.id}>
                        <td className="px-3 font-mono text-xs font-medium">
                          {v.key}
                        </td>
                        <td className="max-w-[200px] truncate px-3 font-mono text-xs">
                          {v.is_secret ? "••••••••" : v.value}
                        </td>
                        <td className="px-3 text-xs text-muted-foreground">
                          {v.description || "—"}
                        </td>
                        <td className="px-3 text-right">
                          <div className="flex justify-end gap-1">
                            {hasCap(profile, "canEditVars") && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                aria-label={`Edit ${v.key}`}
                                title={`Edit ${v.key}`}
                                onClick={() => openEdit(v)}
                              >
                                <Settings2 className="h-4 w-4" />
                              </Button>
                            )}
                            {hasCap(profile, "canDeleteVars") && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                aria-label={`Delete ${v.key}`}
                                title={`Delete ${v.key}`}
                                onClick={() => setDeleteItem(v)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {formOpen && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              {editId ? (
                <Settings2 className="h-4 w-4" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              {editId ? t("vars.edit") : t("vars.add")}
            </div>
            <div className="space-y-1">
              <Label htmlFor="ansible-var-key">{t("vars.key")}</Label>
              <Input
                id="ansible-var-key"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="my_variable"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                {t("vars.keyHint")}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ansible-var-value">{t("vars.value")}</Label>
              <Input id="ansible-var-value" type={isSecret ? "password" : "text"} value={value} onChange={(e) => setValue(e.target.value)} placeholder={editId && isSecret ? "Leave empty to keep the existing secret" : undefined} autoComplete="new-password" />
            </div>
            <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
              <span><span className="block font-medium">Secret value</span><span className="text-xs text-muted-foreground">Encrypted at rest and never returned by the API.</span></span>
              <Switch aria-label="Secret value" checked={isSecret} onCheckedChange={setIsSecret} />
            </label>
            <div className="space-y-1">
              <Label htmlFor="ansible-var-description">{t("vars.description")}</Label>
              <Input id="ansible-var-description" value={desc} onChange={(e) => setDesc(e.target.value)} />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setFormOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                onClick={() => saveMut.mutate()}
                disabled={saveMut.isPending}
              >
                <Save className="h-4 w-4" /> {t("common.save")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      <ConfirmDialog
        open={!!deleteItem}
        onOpenChange={(open) => {
          if (!open) setDeleteItem(null);
        }}
        title={t("common.delete")}
        description={t("vars.confirmDelete", { key: deleteItem?.key ?? "" })}
        confirmLabel={t("common.delete")}
        variant="destructive"
        confirmTextValue={deleteItem?.key ?? ""}
        confirmInputLabel="Confirm variable key"
        onConfirm={() => {
          if (deleteItem) delMut.mutate(deleteItem.id);
        }}
        isPending={delMut.isPending}
      />
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Tab: Schedules
// ═════════════════════════════════════════════════════════════════════════════
