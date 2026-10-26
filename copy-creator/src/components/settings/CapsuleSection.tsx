import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SettingField } from "../../stores/settingsEditorStore";
import SettingsFieldError from "../SettingsFieldError";
import IosSelect from "../IosSelect";

type CapsuleIconKind = "url" | "file" | "folder";

interface CapsuleSectionProps {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  urlEnabled: boolean;
  setUrlEnabled: (value: boolean) => void;
  pathEnabled: boolean;
  setPathEnabled: (value: boolean) => void;
  durationSeconds: number;
  setDurationSeconds: (value: string) => void;
  onCommitDuration: () => void;
  durationError?: string;
  positionMode: string;
  setPositionMode: (value: string) => void;
  triggerMode: string;
  setTriggerMode: (value: string) => void;
  modifierKey: string;
  setModifierKey: (value: string) => void;
  blacklist: string[];
  setBlacklist: (value: string[]) => void;
  fullscreenEnabled: boolean;
  setFullscreenEnabled: (value: boolean) => void;
  onAddForegroundApp: () => Promise<string | null>;
  onResetFixedPosition: () => void;
  iconUrl: string;
  iconFile: string;
  iconFolder: string;
  onSelectIcon: (kind: CapsuleIconKind) => void;
  onResetIcon: (kind: CapsuleIconKind) => void;
  /** Accepted for parity with the other settings sections; capsule rows commit through their own callbacks. */
  onCommit: (field: SettingField) => void;
  errors: Partial<Record<SettingField, string>>;
}

/** Last path segment for the stored icon path; icons are local absolute paths. */
function baseName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

export function CapsuleSection({
  enabled,
  setEnabled,
  urlEnabled,
  setUrlEnabled,
  pathEnabled,
  setPathEnabled,
  durationSeconds,
  setDurationSeconds,
  onCommitDuration,
  durationError,
  positionMode,
  setPositionMode,
  triggerMode,
  setTriggerMode,
  modifierKey,
  setModifierKey,
  blacklist,
  setBlacklist,
  fullscreenEnabled,
  setFullscreenEnabled,
  onAddForegroundApp,
  onResetFixedPosition,
  iconUrl,
  iconFile,
  iconFolder,
  onSelectIcon,
  onResetIcon,
  errors,
}: CapsuleSectionProps) {
  const { t } = useTranslation();
  const [blacklistInput, setBlacklistInput] = useState("");
  const [blacklistError, setBlacklistError] = useState<string | null>(null);
  const error = durationError ?? errors.capsule_duration_seconds;
  // Dependent rows stay visible but grey out while the master switch is off.
  const dim = enabled ? undefined : { opacity: 0.55 };
  const iconRows: { kind: CapsuleIconKind; label: string; path: string }[] = [
    { kind: "url", label: t("settings.capsule.iconUrl"), path: iconUrl },
    { kind: "file", label: t("settings.capsule.iconFile"), path: iconFile },
    { kind: "folder", label: t("settings.capsule.iconFolder"), path: iconFolder },
  ];

  const addBlacklistEntry = (raw: string) => {
    const name = raw.trim().toLowerCase();
    if (!name) return;
    if (blacklist.some((entry) => entry === name || entry.replace(/\.exe$/, "") === name.replace(/\.exe$/, ""))) {
      setBlacklistError(t("settings.capsule.blacklistDuplicate"));
      return;
    }
    setBlacklist([...blacklist, name]);
    setBlacklistError(null);
    setBlacklistInput("");
  };

  const handleAddForeground = async () => {
    const name = await onAddForegroundApp();
    if (!name) {
      setBlacklistError(t("settings.capsule.blacklistNoForeground"));
      return;
    }
    addBlacklistEntry(name);
  };

  return (
    <>
      <div className="settings-section">
        <div className="settings-section-title">{t("settings.capsule.title")}</div>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row-label">{t("settings.capsule.enabled")}</div>
            <button
              className={`toggle-switch ${enabled ? "on" : "off"}`}
              role="switch" aria-checked={enabled} aria-label={t("settings.capsule.enabled")}
              onClick={() => setEnabled(!enabled)}
              type="button"
              title={enabled ? t("common.on") : t("common.off")}
            >
              <span className="toggle-thumb" />
            </button>
          </div>
          <div className="settings-row vertical">
            <div className="settings-row-hint">{t("settings.capsule.enabledHint")}</div>
          </div>
          <div className="settings-row" style={dim}>
            <div className="settings-row-label">{t("settings.capsule.url")}</div>
            <button
              className={`toggle-switch ${urlEnabled ? "on" : "off"}`}
              role="switch" aria-checked={urlEnabled} aria-label={t("settings.capsule.url")}
              onClick={() => setUrlEnabled(!urlEnabled)}
              type="button" disabled={!enabled}
              title={urlEnabled ? t("common.on") : t("common.off")}
            >
              <span className="toggle-thumb" />
            </button>
          </div>
          <div className="settings-row" style={dim}>
            <div className="settings-row-label">{t("settings.capsule.path")}</div>
            <button
              className={`toggle-switch ${pathEnabled ? "on" : "off"}`}
              role="switch" aria-checked={pathEnabled} aria-label={t("settings.capsule.path")}
              onClick={() => setPathEnabled(!pathEnabled)}
              type="button" disabled={!enabled}
              title={pathEnabled ? t("common.on") : t("common.off")}
            >
              <span className="toggle-thumb" />
            </button>
          </div>
          <div className="settings-row" style={dim}>
            <div className="settings-row-label">{t("settings.capsule.duration")}</div>
            <div className="settings-number-control">
              <input
                className="settings-number-input"
                type="number"
                min={3}
                max={10}
                step={1}
                value={durationSeconds}
                onChange={(event) => setDurationSeconds(event.target.value)}
                onBlur={onCommitDuration}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                disabled={!enabled}
                aria-invalid={!!error}
                aria-describedby={error ? "setting-error-capsule_duration_seconds" : undefined}
                aria-label={t("settings.capsule.duration")}
              />
              <span>{t("settings.capsule.durationUnit")}</span>
            </div>
          </div>
          <SettingsFieldError field="capsule_duration_seconds" error={enabled ? error : undefined} />
          <div className="settings-row" style={dim}>
            <div className="settings-row-label">{t("settings.capsule.position")}</div>
            <IosSelect
              value={positionMode}
              onChange={(value) => setPositionMode(value)}
              options={[
                { value: "top", label: t("settings.capsule.positionTop") },
                { value: "bottom", label: t("settings.capsule.positionBottom") },
                { value: "cursor", label: t("settings.capsule.positionCursor") },
                { value: "fixed", label: t("settings.capsule.positionFixed") },
              ]}
            />
          </div>
          <div className="settings-row vertical" style={dim}>
            <div className="settings-row-hint">{t("settings.capsule.positionHint")}</div>
          </div>
          {positionMode === "fixed" && (
            <div className="settings-row" style={dim}>
              <div className="settings-row-label">{t("settings.capsule.resetPosition")}</div>
              <button
                className="settings-transfer-btn" type="button" disabled={!enabled}
                onClick={onResetFixedPosition}
              >{t("settings.capsule.resetPositionAction")}</button>
            </div>
          )}
          <div className="settings-row" style={dim}>
            <div className="settings-row-label">{t("settings.capsule.trigger")}</div>
            <IosSelect
              value={triggerMode}
              onChange={(value) => setTriggerMode(value)}
              options={[
                { value: "always", label: t("settings.capsule.triggerAlways") },
                { value: "modifier", label: t("settings.capsule.triggerModifier") },
              ]}
            />
          </div>
          {triggerMode === "modifier" && (
            <div className="settings-row" style={dim}>
              <div className="settings-row-label">{t("settings.capsule.modifierKey")}</div>
              <IosSelect
                value={modifierKey}
                onChange={(value) => setModifierKey(value)}
                options={[
                  { value: "ctrl", label: t("settings.capsule.modifierCtrl") },
                  { value: "alt", label: t("settings.capsule.modifierAlt") },
                  { value: "shift", label: t("settings.capsule.modifierShift") },
                ]}
              />
            </div>
          )}
          <div className="settings-row" style={dim}>
            <div className="settings-row-label">{t("settings.capsule.fullscreenSkip")}</div>
            <button
              className={`toggle-switch ${fullscreenEnabled ? "on" : "off"}`}
              role="switch" aria-checked={fullscreenEnabled} aria-label={t("settings.capsule.fullscreenSkip")}
              onClick={() => setFullscreenEnabled(!fullscreenEnabled)}
              type="button" disabled={!enabled}
              title={fullscreenEnabled ? t("common.on") : t("common.off")}
            >
              <span className="toggle-thumb" />
            </button>
          </div>
          <div className="settings-row vertical" style={dim}>
            <div className="settings-row-hint">{t("settings.capsule.fullscreenHint")}</div>
          </div>
        </div>
      </div>
      <div className="settings-section">
        <div className="settings-section-title">{t("settings.capsule.blacklistTitle")}</div>
        <div className="settings-card">
          <div className="settings-row vertical" style={dim}>
            <div className="settings-row-label">{t("settings.capsule.blacklistLabel")}</div>
            <div className="settings-number-control">
              <input
                className="settings-number-input settings-blacklist-input"
                type="text"
                value={blacklistInput}
                placeholder={t("settings.capsule.blacklistPlaceholder")}
                onChange={(event) => { setBlacklistInput(event.target.value); setBlacklistError(null); }}
                onKeyDown={(event) => { if (event.key === "Enter") addBlacklistEntry(blacklistInput); }}
                disabled={!enabled}
                maxLength={120}
                aria-label={t("settings.capsule.blacklistLabel")}
              />
              <button
                className="settings-transfer-btn" type="button" disabled={!enabled || !blacklistInput.trim()}
                onClick={() => addBlacklistEntry(blacklistInput)}
              >{t("settings.capsule.blacklistAdd")}</button>
              <button
                className="settings-transfer-btn" type="button" disabled={!enabled}
                onClick={() => void handleAddForeground()}
              >{t("settings.capsule.blacklistAddForeground")}</button>
            </div>
            {blacklist.length > 0 && (
              <div className="capsule-blacklist-tags">
                {blacklist.map((entry) => (
                  <span className="capsule-blacklist-tag" key={entry}>
                    {entry}
                    <button
                      type="button"
                      aria-label={`${t("settings.capsule.blacklistRemove")} ${entry}`}
                      disabled={!enabled}
                      onClick={() => setBlacklist(blacklist.filter((item) => item !== entry))}
                    >×</button>
                  </span>
                ))}
              </div>
            )}
            {blacklistError && <div className="settings-row-hint settings-field-error">{blacklistError}</div>}
            <div className="settings-row-hint">{t("settings.capsule.blacklistHint")}</div>
          </div>
        </div>
      </div>
      <div className="settings-section">
        <div className="settings-section-title">{t("settings.capsule.icons")}</div>
        <div className="settings-card">
          {iconRows.map((row) => (
            <div className="settings-row vertical" key={row.kind} style={dim}>
              <div className="settings-row-label">{row.label}</div>
              <div className="settings-row-hint" title={row.path || undefined}>
                {row.path
                  ? `${t("settings.capsule.iconCustom")} · ${baseName(row.path)}`
                  : t("settings.capsule.iconDefault")}
              </div>
              <div className="settings-number-control">
                <button
                  className="settings-transfer-btn" type="button" disabled={!enabled}
                  aria-label={`${t("settings.capsule.iconChoose")} - ${row.label}`}
                  onClick={() => onSelectIcon(row.kind)}
                >{t("settings.capsule.iconChoose")}</button>
                <button
                  className="settings-transfer-btn" type="button" disabled={!enabled || !row.path}
                  aria-label={`${t("settings.capsule.iconReset")} - ${row.label}`}
                  onClick={() => onResetIcon(row.kind)}
                >{t("settings.capsule.iconReset")}</button>
              </div>
            </div>
          ))}
          <div className="settings-row vertical">
            <div className="settings-row-hint">{t("settings.capsule.iconCustomHint")}</div>
          </div>
        </div>
      </div>
    </>
  );
}
