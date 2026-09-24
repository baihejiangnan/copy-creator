import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import type { ApiKeyLabel } from "../../types";
import { useClipboardStore } from "../../stores/clipboardStore";

const SERVICE_TEMPLATES = [
  { name: "OpenAI", apiBase: "https://api.openai.com/v1" },
  { name: "DeepSeek", apiBase: "https://api.deepseek.com/v1" },
  { name: "Kimi", apiBase: "https://api.moonshot.cn/v1" },
  { name: "通义千问", apiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { name: "智谱 GLM", apiBase: "https://open.bigmodel.cn/api/paas/v4" },
  { name: "Grok", apiBase: "https://api.x.ai/v1" },
  { name: "Gemini", apiBase: "https://generativelanguage.googleapis.com/v1beta" },
  { name: "Claude", apiBase: "https://api.anthropic.com/v1" },
];
const CUSTOM = "__custom__";
type Service = { name: string; apiBase: string };

interface Props {
  recordId: string;
  keyPreview: string;
  existingLabel: ApiKeyLabel | null | undefined;
  guessedService: string | null | undefined;
  onSave: () => void;
  onCancel: () => void;
}

export default function ApiKeyLabelPanel({
  recordId, keyPreview, existingLabel, guessedService, onSave, onCancel,
}: Props) {
  const { t } = useTranslation();
  const updateRecordLabel = useClipboardStore((s) => s.updateRecordLabel);
  const [savedServices, setSavedServices] = useState<Service[]>([]);
  const initialService = existingLabel?.service || (guessedService !== "OpenAI" ? guessedService : "") || "";
  const [service, setService] = useState(initialService);
  const [customName, setCustomName] = useState("");
  const [apiBase, setApiBase] = useState(existingLabel?.api_base ||
    SERVICE_TEMPLATES.find((item) => item.name === initialService)?.apiBase || "");
  const [note, setNote] = useState(existingLabel?.note || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    invoke<Service[]>("list_api_services")
      .then(setSavedServices)
      .catch((reason) => console.error("Failed to load API services:", reason));
  }, []);

  const services = useMemo(() => {
    const options = new Map(SERVICE_TEMPLATES.map((item) => [item.name, item]));
    for (const item of savedServices) options.set(item.name, item);
    if (existingLabel?.service && !options.has(existingLabel.service)) {
      options.set(existingLabel.service, { name: existingLabel.service, apiBase: existingLabel.api_base });
    }
    return [...options.values()];
  }, [savedServices, existingLabel]);

  const handleServiceChange = (selected: string) => {
    setService(selected);
    setError("");
    setApiBase(selected === CUSTOM ? "" : services.find((item) => item.name === selected)?.apiBase || "");
  };

  const handleSave = async () => {
    const name = (service === CUSTOM ? customName : service).trim();
    const base = apiBase.trim();
    if (!name || name.length > 80) {
      setError(t("clipboard.serviceNameRequired"));
      return;
    }
    if (base) {
      try {
        const url = new URL(base);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error("scheme");
      } catch {
        setError(t("clipboard.invalidApiBase"));
        return;
      }
    }
    setSaving(true);
    setError("");
    try {
      await invoke("save_api_key_label", {
        recordId, keyPreview, service: name, apiBase: base, note: note.trim(),
      });
      updateRecordLabel(recordId, {
        service: name, api_base: base, note: note.trim(),
        is_expired: existingLabel?.is_expired || false,
      });
      onSave();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  const handlePasteBase = async () => {
    if (!apiBase.trim()) return;
    try {
      await invoke("paste_text", { text: apiBase.trim() });
      onCancel();
    } catch (reason) {
      setError(String(reason));
    }
  };

  return (
    <div className="api-key-label-panel" onClick={(event) => event.stopPropagation()}>
      <div className="label-panel-row">
        <span className="label-panel-field-name">{t("clipboard.apiService")}</span>
        <select className="dialog-input label-panel-input" value={service} onChange={(event) => handleServiceChange(event.target.value)}>
          <option value="" disabled>{t("clipboard.selectService")}</option>
          {services.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
          <option value={CUSTOM}>{t("clipboard.addService")}</option>
        </select>
      </div>
      {service === CUSTOM && (
        <div className="label-panel-row">
          <span className="label-panel-field-name">{t("clipboard.serviceName")}</span>
          <input className="dialog-input label-panel-input" value={customName} onChange={(event) => setCustomName(event.target.value)} maxLength={80} />
        </div>
      )}
      <div className="label-panel-row">
        <span className="label-panel-field-name">Base URL</span>
        <input className="dialog-input label-panel-input" value={apiBase} onChange={(event) => setApiBase(event.target.value)} placeholder="https://..." maxLength={2048} />
      </div>
      <div className="label-panel-row">
        <span className="label-panel-field-name">{t("clipboard.apiKeyNote")}</span>
        <input className="dialog-input label-panel-input" value={note} onChange={(event) => setNote(event.target.value)} placeholder={t("clipboard.apiKeyNotePlaceholder")} maxLength={100} />
      </div>
      {error && <div className="label-panel-error" role="alert">{error}</div>}
      <div className="label-panel-actions">
        <button className="label-panel-chip-btn secondary" onClick={handlePasteBase} disabled={!apiBase.trim()} type="button">{t("clipboard.pasteApiBase")}</button>
        <button className="label-panel-chip-btn secondary" onClick={onCancel} type="button">{t("common.cancel")}</button>
        <button className="label-panel-chip-btn primary" onClick={handleSave} disabled={saving} type="button">
          {saving ? t("clipboard.apiKeySaving") : t("common.save")}
        </button>
      </div>
    </div>
  );
}
