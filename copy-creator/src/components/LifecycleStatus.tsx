import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { lifecycleErrorKey, releasePendingStorageOperation, saveBarrier, startLifecycle } from "../lib/lifecycle";
import "../styles/lifecycle.css";

export default function LifecycleStatus() {
  const state = useSyncExternalStore(saveBarrier.subscribe, saveBarrier.getSnapshot);
  const { t } = useTranslation();
  if (state.busy) return <div className="lifecycle-overlay" role="status" aria-live="polite">
    <div className="lifecycle-card">{t("lifecycle.saving")}</div>
  </div>;
  if (!state.error) return null;
  return <div className="lifecycle-error" role="alert">
    <span>{t(lifecycleErrorKey(state.error), { defaultValue: t("lifecycle.failed") })}</span>
    <button onClick={() => { void releasePendingStorageOperation().then(() => {
      saveBarrier.dismissError(); return startLifecycle();
    }).catch((error) => saveBarrier.reportError(error)); }}>{t("common.close")}</button>
  </div>;
}
