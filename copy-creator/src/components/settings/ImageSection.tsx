import { useTranslation } from "react-i18next";
import IosSelect from "../IosSelect";

interface ImageSectionProps {
  maxDimension: number;
  setMaxDimension: (value: number) => void;
  compressionQuality: number;
  setCompressionQuality: (value: number) => void;
  onCommitCompression: (value: number) => void;
  largeImageHandling: string;
  setLargeImageHandling: (value: string) => void;
}

export function ImageSection({
  maxDimension,
  setMaxDimension,
  compressionQuality,
  setCompressionQuality,
  onCommitCompression,
  largeImageHandling,
  setLargeImageHandling,
}: ImageSectionProps) {
  const { t } = useTranslation();
  const dimensionOptions = [1024, 1920, 2560, 4096, 8192].map((value) => ({
    value: String(value),
    label: `${value} px`,
  }));
  const handlingOptions = [
    { value: "compress", label: t("settings.largeImageCompress") },
    { value: "keep", label: t("settings.largeImageKeep") },
    { value: "skip", label: t("settings.largeImageSkip") },
  ];

  return (
    <div className="settings-section">
      <div className="settings-section-title">{t("settings.imageProcessing")}</div>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.imageMaxDimension")}</div>
          <IosSelect
            value={String(maxDimension)}
            options={dimensionOptions}
            onChange={(value) => setMaxDimension(Number(value))}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.imageCompressionQuality")}</div>
          <div className="settings-range-control">
            <input
              type="range"
              min={40}
              max={100}
              step={5}
              value={compressionQuality}
              onChange={(event) => setCompressionQuality(Number(event.target.value))}
              onPointerUp={(event) => onCommitCompression(Number(event.currentTarget.value))}
              onKeyUp={(event) => {
                if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) onCommitCompression(Number(event.currentTarget.value));
              }}
              onBlur={(event) => onCommitCompression(Number(event.currentTarget.value))}
              aria-label={t("settings.imageCompressionQuality")}
            />
            <span>{compressionQuality}%</span>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.largeImageHandling")}</div>
          <IosSelect
            value={largeImageHandling}
            options={handlingOptions}
            onChange={setLargeImageHandling}
          />
        </div>
      </div>
    </div>
  );
}
