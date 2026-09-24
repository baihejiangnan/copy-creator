import { memo, useCallback, useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import StarBorderRoundedIcon from "@mui/icons-material/StarBorderRounded";
import StarRoundedIcon from "@mui/icons-material/StarRounded";
import EditNoteRoundedIcon from "@mui/icons-material/EditNoteRounded";
import { useTranslation } from "react-i18next";
import type { ClipboardRecord } from "../../types";
import { Icons } from "../../components/Icons";
import { ImageThumb } from "./ImageThumb";
import { formatTime, getFileName, TYPE_META } from "./utils";
import ApiKeyLabelPanel from "./ApiKeyLabelPanel";
import FavoriteNoteEditor from "./FavoriteNoteEditor";
import { providerTone } from "./providerBadge";
import { useClipboardStore } from "../../stores/clipboardStore";

const COLLAPSE_TEXT_LENGTH = 160;
const COLLAPSE_LINE_COUNT = 4;
const SELECTABLE_TEXT_TYPES = new Set<ClipboardRecord["type"]>([
  "text",
  "link",
  "explorer",
  "file",
]);

interface ClipboardCardProps {
  record: ClipboardRecord;
  index: number;
  getTypeLabel: (type: string) => string;
  onPaste: (r: ClipboardRecord) => void;
  onDelete: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onThumbHover: (thumbSrc: string, rect: DOMRect) => void;
  onThumbLeave: () => void;
}

function ClipboardCardInner({
  record,
  index,
  getTypeLabel,
  onPaste,
  onDelete,
  onToggleFavorite,
  onThumbHover,
  onThumbLeave,
}: ClipboardCardProps) {
  const { t } = useTranslation();
  const meta = TYPE_META[record.type] || TYPE_META.text;
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [labelOpen, setLabelOpen] = useState(false);
  const [favoriteNoteOpen, setFavoriteNoteOpen] = useState(false);
  const [textExpanded, setTextExpanded] = useState(false);
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [loadingFullContent, setLoadingFullContent] = useState(false);
  const ctxRef = useRef<HTMLDivElement>(null);
  const loadRecords = useClipboardStore((s) => s.loadRecords);
  const getRecordContent = useClipboardStore((s) => s.getRecordContent);
  const setFavoriteNote = useClipboardStore((s) => s.setFavoriteNote);
  const displayContent = fullContent ?? record.content;
  const textLineCount = displayContent.split(/\r\n|\r|\n/).length;
  const canToggleText =
    record.type === "text" &&
    (record.content_truncated ||
      (record.content_length ?? displayContent.length) > COLLAPSE_TEXT_LENGTH ||
      textLineCount > COLLAPSE_LINE_COUNT);
  const isTextExpanded = canToggleText && textExpanded;

  // Close context menu on outside click / ESC
  useEffect(() => {
    if (!ctxMenu) return;
    const handler = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [ctxMenu]);

  const handlePaste = useCallback(() => {
    if (!labelOpen && !favoriteNoteOpen) onPaste(record);
  }, [favoriteNoteOpen, labelOpen, onPaste, record]);

  const handleCardClick = useCallback(
    async (e: React.MouseEvent) => {
      if (labelOpen || favoriteNoteOpen) return;

      const selection = window.getSelection();
      const hasSelectedCardText =
        SELECTABLE_TEXT_TYPES.has(record.type) &&
        selection !== null &&
        !selection.isCollapsed &&
        selection.toString().length > 0 &&
        [selection.anchorNode, selection.focusNode].some(
          (node) => node !== null && e.currentTarget.contains(node),
        );

      if (hasSelectedCardText) {
        e.stopPropagation();
        return;
      }

      if (record.type !== "link" || !e.ctrlKey) {
        handlePaste();
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      try {
        const url = await getRecordContent(record);
        await invoke("open_external_link", { url });
      } catch (error) {
        console.error("Failed to open link:", error);
      }
    },
    [favoriteNoteOpen, getRecordContent, handlePaste, labelOpen, record],
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDelete(record.id);
    },
    [onDelete, record.id],
  );

  const handleToggleFavorite = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setCtxMenu(null);
      if (record.is_favorite) setFavoriteNoteOpen(false);
      onToggleFavorite(record.id);
    },
    [onToggleFavorite, record.id, record.is_favorite],
  );

  const handleOpenFavoriteNote = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setCtxMenu(null);
    setLabelOpen(false);
    setFavoriteNoteOpen(true);
  }, []);

  const handleSaveFavoriteNote = useCallback(
    async (note: string) => {
      await setFavoriteNote(record.id, note);
    },
    [record.id, setFavoriteNote],
  );

  const handleToggleText = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    const nextExpanded = !isTextExpanded;
    setTextExpanded(nextExpanded);

    if (!nextExpanded || !record.content_truncated || fullContent) return;

    setLoadingFullContent(true);
    try {
      setFullContent(await getRecordContent(record));
    } catch {
      setTextExpanded(false);
    } finally {
      setLoadingFullContent(false);
    }
  }, [fullContent, getRecordContent, isTextExpanded, record]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleLabelSaved = useCallback(() => {
    setLabelOpen(false);
  }, []);

  const handleToggleUserApiKey = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      setCtxMenu(null);
      const newValue = !record.user_api_key;
      try {
        await invoke("set_user_api_key", { id: record.id, value: newValue });
        await loadRecords();
      } catch {
        // ignore
      }
    },
    [record.id, record.user_api_key, loadRecords],
  );

  const handleCopyWithComment = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      setCtxMenu(null);
      if (!record.label) return;
      try {
        const content = await getRecordContent(record);
        const text = `# ${record.label.service} — ${record.label.api_base}\n${content}`;
        await navigator.clipboard.writeText(text);
      } catch {
        // Fallback: silently ignore; user can use regular copy
      }
    },
    [getRecordContent, record],
  );

  const hasLabel = Boolean(record.is_api_key && record.label);
  const isUnlabeled = Boolean(record.is_api_key && !record.label);

  // An sk- prefix is shared by multiple providers, so it cannot identify OpenAI.
  const providerName = record.label?.service ||
    (record.guessed_service !== "OpenAI" ? record.guessed_service : null);
  const badgeText = providerName || t("clipboard.unlabeledProvider");

  return (
    <div
      className={`notification clipboard-card type-${record.type}${record.is_favorite ? " is-favorite" : ""}${record.is_api_key ? " has-api-key" : ""}${isUnlabeled ? " api-key-unlabeled" : ""}${hasLabel ? " api-key-labeled" : ""}`}
      style={{ "--color": meta.color, "--enter-delay": index } as React.CSSProperties}
      onClick={handleCardClick}
      onContextMenu={handleContextMenu}
    >
      <div className="notibar" />
      <div className="noticontent">
        <div className="notititle clipboard-card-header">
          <span className="noti-type-label">
            <span className="noti-type-icon">{record.is_api_key ? Icons.key : meta.icon}</span>
            <span className="noti-type-text">{record.is_api_key ? "API Key" : getTypeLabel(record.type)}</span>
          </span>
          {record.is_api_key && (
            <div className="api-key-meta">
              {record.label?.note && (
                <span className="api-key-note" title={record.label.note}>{record.label.note}</span>
              )}
              <button
                type="button"
                className="api-key-badge"
                data-tone={providerTone(providerName)}
                title={providerName || t("clipboard.unlabeledProvider")}
                onClick={(e) => {
                  e.stopPropagation();
                  setFavoriteNoteOpen(false);
                  setLabelOpen((v) => !v);
                }}
              >
                <span className="api-key-badge-dot" aria-hidden="true" />
                <span className="api-key-badge-name">{badgeText}</span>
              </button>
            </div>
          )}
        </div>

        <div
          className={`notibody clipboard-card-body${canToggleText ? " is-toggleable" : ""}${canToggleText && !isTextExpanded ? " is-collapsed" : ""}${isTextExpanded ? " is-expanded" : ""}`}
        >
          {record.type === "image" ? (
            <ImageThumb
              record={record}
              onHover={onThumbHover}
              onLeave={onThumbLeave}
              onClick={(e) => {
                e.stopPropagation();
                onPaste(record);
              }}
            />
          ) : record.type === "link" ? (
            <span className="clipboard-link-content">{record.content}</span>
          ) : record.type === "explorer" ? (
            <span className="clipboard-explorer-content">{record.content}</span>
          ) : record.type === "file" ? (
            <span className="clipboard-file-content">{getFileName(record.content)}</span>
          ) : (
            <span className="clipboard-text-content" aria-expanded={canToggleText ? isTextExpanded : undefined}>
              {displayContent}
            </span>
          )}
        </div>

        {record.is_favorite && record.favorite_note && !favoriteNoteOpen && (
          <div className="favorite-note-preview" onClick={(event) => event.stopPropagation()}>
            <button
              className="favorite-note-preview-edit"
              type="button"
              title={t("clipboard.editFavoriteNote")}
              aria-label={t("clipboard.editFavoriteNote")}
              onClick={handleOpenFavoriteNote}
            >
              <EditNoteRoundedIcon />
            </button>
            <span>{record.favorite_note}</span>
          </div>
        )}

        {favoriteNoteOpen && record.is_favorite && (
          <FavoriteNoteEditor
            initialNote={record.favorite_note}
            onSave={handleSaveFavoriteNote}
            onCancel={() => setFavoriteNoteOpen(false)}
          />
        )}

        {labelOpen && record.is_api_key && record.key_preview && (
          <ApiKeyLabelPanel
            recordId={record.id}
            keyPreview={record.key_preview}
            existingLabel={record.label}
            guessedService={record.guessed_service}
            onSave={handleLabelSaved}
            onCancel={() => setLabelOpen(false)}
          />
        )}

        <div className="notititle clipboard-card-footer">
          <span className="clipboard-card-time">{formatTime(record.created_at)}</span>
          <div className="clipboard-card-actions">
            {record.is_api_key && (
              <button
                className="card-detail-btn"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setFavoriteNoteOpen(false);
                  setLabelOpen((open) => !open);
                }}
                aria-expanded={labelOpen}
                title={t("clipboard.apiKeyDetails")}
              >
                {t("clipboard.apiKeyDetails")}
              </button>
            )}
            {record.is_favorite && (
              <button
                className={`card-note-btn${record.favorite_note ? " has-note" : ""}`}
                onClick={handleOpenFavoriteNote}
                type="button"
                title={
                  record.favorite_note
                    ? t("clipboard.editFavoriteNote")
                    : t("clipboard.addFavoriteNote")
                }
                aria-label={
                  record.favorite_note
                    ? t("clipboard.editFavoriteNote")
                    : t("clipboard.addFavoriteNote")
                }
              >
                <EditNoteRoundedIcon />
              </button>
            )}
            <button
              className={`card-favorite-btn${record.is_favorite ? " active" : ""}`}
              onClick={handleToggleFavorite}
              type="button"
              title={record.is_favorite ? t("clipboard.unfavorite") : t("clipboard.favorite")}
              aria-label={record.is_favorite ? t("clipboard.unfavorite") : t("clipboard.favorite")}
            >
              {record.is_favorite ? <StarRoundedIcon /> : <StarBorderRoundedIcon />}
            </button>
            {canToggleText && (
              <button
                className="card-toggle-text-btn"
                onClick={handleToggleText}
                type="button"
                aria-expanded={isTextExpanded}
                aria-label={isTextExpanded ? "收起长文本" : "展开完整文本"}
                disabled={loadingFullContent}
              >
                <span>{loadingFullContent ? "加载" : isTextExpanded ? "收起" : "展开"}</span>
              </button>
            )}
            <button className="card-delete-btn" onClick={handleDelete}>
              {Icons.delete}
            </button>
          </div>
        </div>
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <div
          ref={ctxRef}
          className="clipboard-ctx-menu"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button className="ctx-menu-item" onClick={handleToggleFavorite}>
            {record.is_favorite ? <StarRoundedIcon /> : <StarBorderRoundedIcon />}
            {record.is_favorite ? t("clipboard.unfavorite") : t("clipboard.favorite")}
          </button>
          {record.is_favorite && (
            <button className="ctx-menu-item" onClick={handleOpenFavoriteNote}>
              <EditNoteRoundedIcon />
              {record.favorite_note
                ? t("clipboard.editFavoriteNote")
                : t("clipboard.addFavoriteNote")}
            </button>
          )}
          <div className="ctx-menu-sep" />
          {record.is_api_key && (
            <button
              className="ctx-menu-item"
              onClick={(e) => {
                e.stopPropagation();
                setCtxMenu(null);
                setLabelOpen(true);
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                <line x1="7" y1="7" x2="7.01" y2="7" />
              </svg>
              {t("clipboard.apiKeyDetails")}
            </button>
          )}
          {record.is_api_key && record.label?.api_base && (
            <button className="ctx-menu-item" onClick={(event) => {
              event.stopPropagation();
              setCtxMenu(null);
              invoke("paste_text", { text: record.label!.api_base }).catch(console.error);
            }}>
              {t("clipboard.pasteApiBase")}
            </button>
          )}
          {record.is_api_key && hasLabel && (
            <button className="ctx-menu-item" onClick={handleCopyWithComment}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              复制含注释
            </button>
          )}
          {record.type === "text" && !record.is_api_key && (
            <button className="ctx-menu-item" onClick={handleToggleUserApiKey}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                <line x1="7" y1="7" x2="7.01" y2="7" />
              </svg>
              标记为 API Key
            </button>
          )}
          {record.user_api_key && (
            <button className="ctx-menu-item" onClick={handleToggleUserApiKey}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
              取消 API Key 标记
            </button>
          )}
          {(record.is_api_key || (record.type === "text" && !record.is_api_key)) && <div className="ctx-menu-sep" />}
          <button
            className="ctx-menu-item"
            onClick={(e) => {
              e.stopPropagation();
              setCtxMenu(null);
              onPaste(record);
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            粘贴
          </button>
          <div className="ctx-menu-sep" />
          <button
            className="ctx-menu-item danger"
            onClick={(e) => {
              e.stopPropagation();
              setCtxMenu(null);
              onDelete(record.id);
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            </svg>
            删除
          </button>
        </div>
      )}
    </div>
  );
}

export const ClipboardCard = memo(ClipboardCardInner);
