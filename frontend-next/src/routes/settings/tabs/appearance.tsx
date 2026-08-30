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
import { THEME_PRESETS, useUi } from "@/lib/store";
import { cn } from "@/lib/utils";
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
  const themePreset = useUi((state) => state.themePreset);
  const setThemePreset = useUi((state) => state.setThemePreset);
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
        <SettingsRow label={t("set.appName")} hint={t("set.appNameHint")}>
          <Input
            value={appName}
            onChange={(e) => setAppName(e.target.value)}
            placeholder="Shipyard"
            className="max-w-xs"
          />
        </SettingsRow>

        <SettingsRow
          label={t("set.accentColor")}
          hint={t("set.accentColorHint")}
        >
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-9 w-12 cursor-pointer rounded border border-input bg-background"
          />
          <Input
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
        <SettingsRow label="Show VM IDs" hint="Display the Proxmox VMID before each guest name in the infrastructure tree." noBorder>
          <Switch aria-label="Show VM IDs in infrastructure tree" checked={showVmIds} onCheckedChange={setShowVmIds} />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection
        icon={<Paintbrush className="h-4 w-4" />}
        title="Console theme"
        description="Choose a complete, coordinated color palette. The selection is applied to this console immediately."
      >
        <div className="grid gap-3 p-1 sm:grid-cols-2 xl:grid-cols-3">
          {THEME_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => setThemePreset(preset.id)}
              aria-pressed={themePreset === preset.id}
              aria-label={`${preset.name} theme, ${preset.mode} mode`}
              className={cn(
                "rounded-[3px] border p-3 text-left transition-colors hover:border-primary/50",
                themePreset === preset.id
                  ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                  : "bg-card hover:bg-muted/30",
              )}
            >
              <div
                className="mb-3 flex h-12 overflow-hidden rounded-sm border border-black/10"
                style={{ backgroundColor: preset.preview.canvas }}
              >
                <span
                  className="w-[34%]"
                  style={{
                    backgroundColor: preset.preview.surface,
                    borderRight: `3px solid ${preset.preview.accent}`,
                  }}
                />
                <span
                  className="flex-1 p-2"
                  style={{ backgroundColor: preset.preview.canvas }}
                >
                  <span
                    className="block h-2.5 w-2/3 rounded-sm"
                    style={{ backgroundColor: preset.preview.accent }}
                  />
                  <span
                    className="mt-2 block h-2 w-full rounded-sm shadow-sm"
                    style={{ backgroundColor: preset.preview.card }}
                  />
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{preset.name}</span>
                <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {preset.mode === "dark" ? "Dark" : "Light"}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {preset.description}
              </p>
            </button>
          ))}
        </div>
      </SettingsSection>
    </div>
  );
}
