import { getStorageIdentity, invokeStorage, onStorageIdentity } from "../../lib/storageIdentity";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import IosSelect from "../IosSelect";
import IosMultiSelect from "../IosMultiSelect";
import { useVaultStore } from "../../stores/vaultStore";
import type { SettingField } from "../../stores/settingsEditorStore";
import SettingsFieldError from "../SettingsFieldError";

export interface ClipboardStorageStats {
  record_count: number;
  favorite_count: number;
  usage_bytes: number;
  max_history_items: number;
  max_storage_bytes: number;
  over_limit: boolean;
}

interface ClipboardSectionProps {
  dedupeWindowSeconds: number;
  setDedupeWindowSeconds: (value: number) => void;
  maxHistoryItems: string;
  setMaxHistoryItems: (value: string) => void;
  maxStorageMb: string;
  setMaxStorageMb: (value: string) => void;
  onCommit: (field: SettingField) => void;
  errors: Partial<Record<SettingField, string>>;
  notifications: boolean;
  setNotifications: (value: boolean) => void;
  stats: ClipboardStorageStats | null;
  onCleanup: () => Promise<void>;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ClipboardSection({
  dedupeWindowSeconds,
  setDedupeWindowSeconds,
  maxHistoryItems,
  setMaxHistoryItems,
  maxStorageMb,
  setMaxStorageMb,
  notifications,
  setNotifications,
  stats,
  onCleanup,
  onCommit,
  errors,
}: ClipboardSectionProps) {
  const { t } = useTranslation();
  const [deletePeriod, setDeletePeriod] = useState("1month");
  const [deleteCategories, setDeleteCategories] = useState<string[]>(["text", "image", "link", "explorer", "file"]);
  const [pending, setPending] = useState<{ mode: "dedupe" | "older_than"; period?: string; categories?: string[]; count: number; epoch: number } | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupStatus, setCleanupStatus] = useState("");
  useEffect(() => onStorageIdentity(() => { setPending(null); setCleanupStatus(""); }), []);
  const categoryOptions = [
    ...["text", "image", "link", "explorer", "file", "apikey"].map((value) => ({ value, label: t(`clipboard.${value}`) })),
    { value: "vault", label: t("tabs.vault") },
  ];
  const periodOptions = [
    { value: "2months", label: t("settings.deleteBefore2Months") },
    { value: "1month", label: t("settings.deleteBefore1Month") },
    { value: "7days", label: t("settings.deleteBefore7Days") },
    { value: "3days", label: t("settings.deleteBefore3Days") },
    { value: "today", label: t("settings.deleteBeforeToday") },
  ];
  const cleanupError = (error: unknown) => String(error) === "vault.locked"
    ? t("settings.cleanupVaultLocked")
    : `${t("settings.cleanupFailed")}: ${String(error)}`;
  const previewCleanup = async (mode: "dedupe" | "older_than") => {
    setCleanupBusy(true);
    setPending(null);
    setCleanupStatus("");
    try {
      const period = mode === "older_than" ? deletePeriod : undefined;
      const categories = mode === "older_than" ? [...deleteCategories] : undefined;
      const epoch = await getStorageIdentity();
      const count = await invokeStorage<number>("preview_clipboard_cleanup", { mode, period, categories }, epoch);
      if (count === 0) {
        setPending(null);
        setCleanupStatus(t("settings.cleanupNone"));
      } else {
        setPending({ mode, period, categories, count, epoch });
      }
    } catch (error) {
      setCleanupStatus(cleanupError(error));
    } finally {
      setCleanupBusy(false);
    }
  };
  const applyCleanup = async () => {
    if (!pending) return;
    setCleanupBusy(true);
    try {
      const count = await invokeStorage<number>("apply_clipboard_cleanup", { mode: pending.mode, period: pending.period, categories: pending.categories }, pending.epoch);
      setCleanupStatus(t("settings.cleanupDone", { count }));
      setPending(null);
      if (pending.categories?.includes("vault")) {
        useVaultStore.getState().clearSelected();
        await useVaultStore.getState().refresh();
      }
      await onCleanup();
    } catch (error) {
      setPending(null);
      setCleanupStatus(cleanupError(error));
    } finally {
      setCleanupBusy(false);
    }
  };
  const usagePercent = stats
    ? Math.min(
        100,
        Math.max(
          (stats.record_count / Math.max(Number(maxHistoryItems) || stats.max_history_items, 1)) * 100,
          (stats.usage_bytes / Math.max((Number(maxStorageMb) || stats.max_storage_bytes / 1024 / 1024) * 1024 * 1024, 1)) * 100,
        ),
      )
    : 0;

  return (
    <div className="settings-section">
      <div className="settings-section-title">{t("settings.clipboard")}</div>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.dedupeWindow")}</div>
          <IosSelect
            value={String(dedupeWindowSeconds)}
            onChange={(value) => setDedupeWindowSeconds(Number(value))}
            options={[
              { value: "1", label: t("settings.dedupe1second") },
              { value: "5", label: t("settings.dedupe5seconds") },
              { value: "30", label: t("settings.dedupe30seconds") },
              { value: "60", label: t("settings.dedupe1minute") },
              { value: "300", label: t("settings.dedupe5minutes") },
              { value: "900", label: t("settings.dedupe15minutes") },
              { value: "1800", label: t("settings.dedupe30minutes") },
            ]}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.maxHistoryItems")}</div>
          <div className="settings-number-control">
            <input
              className="settings-number-input"
              type="number"
              min={100}
              max={100000}
              step={100}
              value={maxHistoryItems}
              onChange={(event) => setMaxHistoryItems(event.target.value)}
              onBlur={() => onCommit("max_history_items")}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              aria-invalid={!!errors.max_history_items}
              aria-describedby={errors.max_history_items ? "setting-error-max_history_items" : undefined}
              aria-label={t("settings.maxHistoryItems")}
            />
            <span>{t("settings.items")}</span>
          </div>
        </div>
        <SettingsFieldError field="max_history_items" error={errors.max_history_items} />
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.maxStorageSize")}</div>
          <div className="settings-number-control">
            <input
              className="settings-number-input"
              type="number"
              min={50}
              max={100000}
              step={50}
              value={maxStorageMb}
              onChange={(event) => setMaxStorageMb(event.target.value)}
              onBlur={() => onCommit("max_storage_mb")}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              aria-invalid={!!errors.max_storage_mb}
              aria-describedby={errors.max_storage_mb ? "setting-error-max_storage_mb" : undefined}
              aria-label={t("settings.maxStorageSize")}
            />
            <span>MB</span>
          </div>
        </div>
        <SettingsFieldError field="max_storage_mb" error={errors.max_storage_mb} />
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.clipboardNotifications")}</div>
          <button
            className={`toggle-switch ${notifications ? "on" : "off"}`}
            role="switch" aria-checked={notifications} aria-label={t("settings.clipboardNotifications")}
            onClick={() => setNotifications(!notifications)}
            type="button"
            title={notifications ? t("common.on") : t("common.off")}
          >
            <span className="toggle-thumb" />
          </button>
        </div>
        <div className="settings-row vertical">
          <div className="settings-row-label">{t("settings.manualDedupe")}</div>
          <button className="settings-transfer-btn" type="button" disabled={cleanupBusy} onClick={() => previewCleanup("dedupe")}>{t("settings.previewDedupe")}</button>
          <div className="settings-row-hint">{t("settings.dedupeSafetyHint")}</div>
        </div>
        <div className="settings-row vertical">
          <div className="settings-row-label">{t("settings.bulkDelete")}</div>
          <fieldset className="cleanup-filters" disabled={cleanupBusy}>
            <div className="settings-row-hint">{t("settings.deleteTime")}</div>
            <IosSelect
              value={deletePeriod}
              onChange={(value) => { setDeletePeriod(value); setPending(null); setCleanupStatus(""); }}
              options={periodOptions}
            />
            <div className="settings-row-hint">{t("settings.deleteCategories")}</div>
            <IosMultiSelect
              value={deleteCategories}
              options={categoryOptions}
              label={t("settings.deleteCategories")}
              placeholder={t("settings.deleteCategoriesPlaceholder")}
              disabled={cleanupBusy}
              onChange={(value) => { setDeleteCategories(value); setPending(null); setCleanupStatus(""); }}
            />
          </fieldset>
          <button className="settings-transfer-btn" type="button" disabled={cleanupBusy || deleteCategories.length === 0} onClick={() => previewCleanup("older_than")}>{t("settings.previewDelete")}</button>
          <div className="settings-row-hint">{t("settings.deleteSafetyHint")}</div>
          {deleteCategories.includes("vault") && <div className="settings-row-hint">{t("settings.deleteVaultHint")}</div>}
        </div>
        {pending && <div className="settings-row vertical" role="alert">
          {pending.mode === "older_than" && <div className="settings-row-hint">{t("settings.cleanupScope", {
            period: periodOptions.find((option) => option.value === pending.period)?.label,
            categories: categoryOptions.filter((option) => pending.categories?.includes(option.value)).map((option) => option.label).join("、"),
          })}</div>}
          <div>{t("settings.cleanupConfirm", { count: pending.count })}</div>
          <div className="settings-number-control">
            <button className="settings-transfer-btn" type="button" disabled={cleanupBusy} onClick={applyCleanup}>{t("settings.confirmCleanup")}</button>
            <button className="settings-transfer-btn" type="button" disabled={cleanupBusy} onClick={() => setPending(null)}>{t("settings.cancelCleanup")}</button>
          </div>
        </div>}
        {cleanupStatus && <div className="settings-transfer-status" role="status">{cleanupStatus}</div>}
        {stats && (
          <div className="settings-row vertical settings-usage-row">
            <div className="settings-usage-summary">
              <span>
                {t("settings.storageUsage", {
                  count: stats.record_count,
                  size: formatBytes(stats.usage_bytes),
                })}
              </span>
              <span>{t("settings.favoriteCount", { count: stats.favorite_count })}</span>
            </div>
            <progress className="settings-usage-progress" value={usagePercent} max={100} />
          </div>
        )}
      </div>
    </div>
  );
}
