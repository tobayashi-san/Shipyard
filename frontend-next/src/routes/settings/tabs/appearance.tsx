import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Paintbrush, Save } from "lucide-react";
import { api } from "@/lib/api";
import { showToast } from "@/lib/toast";
import { useSettings } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SettingsRow, SettingsSection } from "../_row";
import { useUi } from "@/lib/store";
import { useUnsavedChanges } from "@/lib/use-unsaved-changes";

const DEFAULTS = {
  appName: "",
  accentColor: "#3b82f6",
};

interface WhiteLabel {
  appName?: string;
  accentColor?: string;
}

export function AppearanceTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const wl = (settings as unknown as WhiteLabel) || {};

  const [appName, setAppName] = useState(wl.appName || "");
  const [color, setColor] = useState(wl.accentColor || DEFAULTS.accentColor);
  const showVmIds = useUi((state) => state.showInfrastructureVmIds);
  const setShowVmIds = useUi((state) => state.setShowInfrastructureVmIds);
  const dirty = appName !== (wl.appName || "") || color !== (wl.accentColor || DEFAULTS.accentColor);
  useUnsavedChanges(dirty);

  // Hydrate when settings load
  useEffect(() => {
    setAppName(wl.appName || "");
    setColor(wl.accentColor || DEFAULTS.accentColor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const save = useMutation({
    mutationFn: (data: Record<string, unknown>) => api.saveSettings(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      showToast(t("set.toastSaved"), "success");
    },
    onError: () => showToast(t("set.toastErrorSave"), "error"),
  });

  const reset = useMutation({
    mutationFn: () => api.saveSettings({ appName: "", accentColor: "" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      setAppName("");
      setColor(DEFAULTS.accentColor);
      showToast(t("set.toastReset"), "success");
    },
    onError: () => showToast(t("set.toastErrorReset"), "error"),
  });

  const handleSave = () => {
    save.mutate({
      appName: appName.trim() || undefined,
      accentColor: color,
    });
  };

  return (
    <div className="space-y-5">
      <SettingsSection
        icon={<Paintbrush className="h-4 w-4" />}
        title={t("set.whiteLabel")}
        description={t("set.brandingDesc")}
      >
        <SettingsRow label={t("set.appName")} labelId="appearance-app-name-label" hint={t("set.appNameHint")}>
          <Input
            aria-labelledby="appearance-app-name-label"
            value={appName}
            onChange={(e) => setAppName(e.target.value)}
            placeholder="Shipyard"
            className="max-w-xs"
          />
        </SettingsRow>

        <SettingsRow
          label={t("set.accentColor")}
          labelId="appearance-accent-color-label"
          hint={t("set.accentColorHint")}
        >
          <input
            aria-labelledby="appearance-accent-color-label"
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-9 w-12 cursor-pointer rounded border border-input bg-background"
          />
          <Input
            aria-labelledby="appearance-accent-color-label"
            value={color}
            onChange={(e) => {
              const v = e.target.value;
              setColor(v);
            }}
            className="max-w-[140px] font-mono"
            placeholder="#3b82f6"
          />
        </SettingsRow>

        <SettingsRow label={null} noBorder>
          <Button onClick={handleSave} disabled={save.isPending || !dirty} size="sm">
            <Save className="h-4 w-4" />{" "}
            {save.isPending ? t("set.saving") : t("set.saveApply")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => reset.mutate()}
            disabled={reset.isPending}
          >
            {t("common.reset")}
          </Button>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection
        icon={<Paintbrush className="h-4 w-4" />}
        title="Navigation"
        description="Choose how infrastructure inventory is represented in the sidebar."
      >
        <SettingsRow label="Show VM IDs" hint="Display the Proxmox VMID before each virtual machine name in the infrastructure tree." noBorder>
          <Switch aria-label="Show VM IDs in infrastructure tree" checked={showVmIds} onCheckedChange={setShowVmIds} />
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}
