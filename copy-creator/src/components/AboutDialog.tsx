import "../styles/updates.css";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateStore } from "../stores/updateStore";
import UpdateCheck from "./UpdateCheck";

export default function AboutDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { info, initialize, openLink } = useUpdateStore();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    void initialize();
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [initialize]);

  return (
    <dialog ref={dialogRef} className="about-dialog" aria-labelledby="about-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="about-content">
        <button className="about-close" onClick={onClose} aria-label={t("common.close")}>×</button>
        <img className="about-logo" src="/logo.png" alt="" draggable={false} />
        <h2 id="about-title">{info?.name ?? "Copy Creator"}</h2>
        <span className="update-version">{info ? `v${info.version}` : t("common.loading")}</span>
        <p className="about-description">{t("about.description")}</p>
        {info && <>
          <p className="about-meta">{info.author} · {info.license} {t("about.license")}</p>
          <button className="project-link" onClick={() => void openLink(info.repositoryUrl)}>
            {info.repositoryUrl.replace("https://", "")}
          </button>
          <p className="about-meta">{t("about.forkedFrom")} <button className="project-link"
            onClick={() => void openLink(info.upstreamUrl)}>hu-qi-jia / copy-creator</button></p>
        </>}
        <div className="about-update"><UpdateCheck /></div>
      </div>
    </dialog>
  );
}
