import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import IosSelect from "../IosSelect";

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
  maxHistoryItems: number;
  setMaxHistoryItems: (value: number) => void;
  maxStorageMb: number;
  setMaxStorageMb: (value: number) => void;
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
}: ClipboardSectionProps) {
  const { t } = useTranslation();
  const [deletePeriod, setDeletePeriod] = useState("1month");
  const [pending, setPending] = useState<{ mode: "dedupe" | "older_than"; period?: string; count: number } | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupStatus, setCleanupStatus] = useState("");
  const previewCleanup = async (mode: "dedupe" | "older_than") => {
    setCleanupBusy(true);
    setCleanupStatus("");
    try {
      const period = mode === "older_than" ? deletePeriod : undefined;
      const count = await invoke<number>("preview_clipboard_cleanup", { mode, period });
      if (count === 0) {
        setPending(null);
        setCleanupStatus(t("settings.cleanupNone"));
      } else {
        setPending({ mode, period, count });
      }
    } catch (error) {
      setCleanupStatus(`${t("settings.cleanupFailed")}: ${String(error)}`);
    } finally {
      setCleanupBusy(false);
    }
  };
  const applyCleanup = async () => {
    if (!pending) return;
    setCleanupBusy(true);
    try {
      const count = await invoke<number>("apply_clipboard_cleanup", { mode: pending.mode, period: pending.period });
      setCleanupStatus(t("settings.cleanupDone", { count }));
      setPending(null);
      await onCleanup();
    } catch (error) {
      setCleanupStatus(`${t("settings.cleanupFailed")}: ${String(error)}`);
    } finally {
      setCleanupBusy(false);
    }
  };
  const usagePercent = stats
    ? Math.min(
        100,
        Math.max(
          (stats.record_count / Math.max(maxHistoryItems, 1)) * 100,
          (stats.usage_bytes / Math.max(maxStorageMb * 1024 * 1024, 1)) * 100,
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
              onChange={(event) => setMaxHistoryItems(Number(event.target.value))}
              aria-label={t("settings.maxHistoryItems")}
            />
            <span>{t("settings.items")}</span>
          </div>
        </div>
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
              onChange={(event) => setMaxStorageMb(Number(event.target.value))}
              aria-label={t("settings.maxStorageSize")}
            />
            <span>MB</span>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.clipboardNotifications")}</div>
          <button
            className={`toggle-switch ${notifications ? "on" : "off"}`}
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
          <IosSelect
            value={deletePeriod}
            onChange={(value) => { setDeletePeriod(value); setPending(null); }}
            options={[
              { value: "2months", label: t("settings.deleteBefore2Months") },
              { value: "1month", label: t("settings.deleteBefore1Month") },
              { value: "7days", label: t("settings.deleteBefore7Days") },
              { value: "3days", label: t("settings.deleteBefore3Days") },
              { value: "today", label: t("settings.deleteBeforeToday") },
            ]}
          />
          <button className="settings-transfer-btn" type="button" disabled={cleanupBusy} onClick={() => previewCleanup("older_than")}>{t("settings.previewDelete")}</button>
          <div className="settings-row-hint">{t("settings.deleteSafetyHint")}</div>
        </div>
        {pending && <div className="settings-row vertical" role="alert">
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
