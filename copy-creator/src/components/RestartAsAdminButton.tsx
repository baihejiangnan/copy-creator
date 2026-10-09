import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { saveBarrier, startLifecycle } from "../lib/lifecycle";

export default function RestartAsAdminButton() {
  const { t } = useTranslation();
  const [requesting, setRequesting] = useState(false);
  const barrier = useSyncExternalStore(saveBarrier.subscribe, saveBarrier.getSnapshot);
  const restart = async () => {
    if (requesting || barrier.busy) return;
    setRequesting(true);
    try {
      await startLifecycle();
      await invoke("request_app_elevated_restart");
    } catch (error) { saveBarrier.reportError(error); }
    finally { setRequesting(false); }
  };
  return <button type="button" className="restart-admin-button" disabled={requesting || barrier.busy}
    title={t("clipboard.restartAsAdminHint")} onClick={() => void restart()}>
    {t("clipboard.restartAsAdmin")}
  </button>;
}
