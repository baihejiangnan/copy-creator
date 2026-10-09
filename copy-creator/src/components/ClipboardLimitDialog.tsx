import "../styles/settings-status.css";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsEditorStore } from "../stores/settingsEditorStore";

export default function ClipboardLimitDialog() {
  const { t } = useTranslation();
  const { limitConfirmation: proposal, pending, cancelLimit, confirmLimit } = useSettingsEditorStore();
  const ref = useRef<HTMLDialogElement>(null);
  const open = !!proposal;
  useEffect(() => {
    const dialog = ref.current;
    if (!open) return;
    const previous = document.activeElement;
    dialog?.showModal();
    return () => { dialog?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [open]);
  if (!proposal) return null;
  return <dialog ref={ref} className="settings-limit-dialog" aria-labelledby="limit-confirm-title"
    onCancel={(event) => { event.preventDefault(); if (!pending) cancelLimit(); }}>
    <h3 id="limit-confirm-title">{t("settings.limitConfirmTitle")}</h3>
    <p>{t("settings.limitConfirmDescription", { count: proposal.count,
      label: t(proposal.field === "max_history_items" ? "settings.maxHistoryItems" : "settings.maxStorageSize"), value: proposal.value })}</p>
    <p className="settings-row-hint">{t("settings.limitProtectedHint")}</p>
    <div className="dialog-actions">
      <button className="dialog-btn secondary" disabled={pending > 0} onClick={cancelLimit}>{t("common.cancel")}</button>
      <button className="dialog-btn primary" disabled={pending > 0} onClick={confirmLimit}>{t("settings.confirmLimit")}</button>
    </div>
  </dialog>;
}
