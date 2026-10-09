import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import KeyboardArrowUpRoundedIcon from "@mui/icons-material/KeyboardArrowUpRounded";
import { useClipboardStore, type ClipType } from "../../stores/clipboardStore";
import { Icons } from "../../components/Icons";
import SearchInput from "../../components/SearchInput";
import { ClipboardCard } from "./ClipboardCard";
import { TYPE_META } from "./utils";
import { useWindowVisible } from "../../lib/documentVisible";

TYPE_META.text.icon = Icons.clipboard;
TYPE_META.image.icon = Icons.image;
TYPE_META.link.icon = Icons.link;
TYPE_META.explorer.icon = Icons.link;
TYPE_META.file.icon = Icons.file;

const SCROLL_TOP_BUTTON_THRESHOLD = 180;

export default function ClipboardPage() {
  const { t } = useTranslation();
  const windowVisible = useWindowVisible();
  const {
    records,
    search,
    loading,
    hasMore,
    category,
    init,
    setSearch,
    setCategory,
    loadRecords,
    deleteRecord,
    toggleFavorite,
    pasteRecord,
  } = useClipboardStore(
    useShallow((state) => ({
      records: state.records,
      search: state.search,
      loading: state.loading,
      hasMore: state.hasMore,
      category: state.category,
      init: state.init,
      setSearch: state.setSearch,
      setCategory: state.setCategory,
      loadRecords: state.loadRecords,
      deleteRecord: state.deleteRecord,
      toggleFavorite: state.toggleFavorite,
      pasteRecord: state.pasteRecord,
    })),
  );

  const pageRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [hoverPreview, setHoverPreview] = useState<{ src: string; x: number; y: number } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const categories: { key: ClipType; label: string }[] = [
    { key: "all", label: t("clipboard.all") },
    { key: "favorite", label: t("clipboard.favorites") },
    { key: "text", label: t("clipboard.text") },
    { key: "image", label: t("clipboard.image") },
    { key: "link", label: t("clipboard.link") },
    { key: "explorer", label: t("clipboard.explorer") },
    { key: "file", label: t("clipboard.file") },
    { key: "apikey", label: t("clipboard.apikey") },
  ];

  const labels: Record<string, string> = useMemo(
    () => ({
      text: t("clipboard.text"),
      image: t("clipboard.image"),
      link: t("clipboard.link"),
      explorer: t("clipboard.explorer"),
      file: t("clipboard.file"),
    }),
    [t],
  );

  const getTypeLabel = useCallback(
    (type: string): string => labels[type] || labels.text,
    [labels],
  );

  const handlePaste = useCallback(
    (r: typeof records[number]) => pasteRecord(r),
    [pasteRecord],
  );

  const handleDelete = useCallback(
    (id: string) => deleteRecord(id),
    [deleteRecord],
  );

  const handleToggleFavorite = useCallback(
    (id: string) => toggleFavorite(id),
    [toggleFavorite],
  );

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearch(value);
    },
    [setSearch],
  );

  const handleCategoryChange = useCallback(
    (value: ClipType) => {
      setCategory(value);
      loadRecords();
    },
    [setCategory, loadRecords],
  );

  const handleListRef = useCallback((list: HTMLDivElement | null) => {
    listRef.current = list;
    setShowScrollTop(Boolean(list && list.scrollTop > SCROLL_TOP_BUTTON_THRESHOLD));
  }, []);

  const handleListScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setShowScrollTop(event.currentTarget.scrollTop > SCROLL_TOP_BUTTON_THRESHOLD);
  }, []);

  const handleScrollToTop = useCallback(() => {
    listRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const filtered = useMemo(() => {
    if (category === "all") return records;
    if (category === "favorite") return records.filter((r) => r.is_favorite);
    if (category === "apikey") return records.filter((r) => r.is_api_key);
    return records.filter((r) => r.type === category);
  }, [records, category]);

  useEffect(() => {
    init();
    useClipboardStore.getState().setVisible(windowVisible);
    return () => useClipboardStore.getState().setVisible(false);
  }, [init, windowVisible]);

  useEffect(() => {
    const timer = setTimeout(() => loadRecords(), 300);
    return () => clearTimeout(timer);
  }, [loadRecords, search]);

  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;

    let ctrlPressed = false;
    const setCtrlPressed = (pressed: boolean) => {
      if (ctrlPressed === pressed) return;
      ctrlPressed = pressed;
      page.classList.toggle("is-ctrl-pressed", pressed);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Control" || event.ctrlKey) setCtrlPressed(true);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Control" || !event.ctrlKey) setCtrlPressed(false);
    };
    const handlePointerMove = (event: PointerEvent) => setCtrlPressed(event.ctrlKey);
    const clearCtrlPressed = () => setCtrlPressed(false);

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", clearCtrlPressed);
    page.addEventListener("pointermove", handlePointerMove);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", clearCtrlPressed);
      page.removeEventListener("pointermove", handlePointerMove);
      page.classList.remove("is-ctrl-pressed");
    };
  }, []);

  const handleThumbHover = useCallback((thumbSrc: string, rect: DOMRect) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setHoverPreview({ src: thumbSrc, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }, []);

  const handleThumbLeave = useCallback(() => {
    hoverTimerRef.current = setTimeout(() => setHoverPreview(null), 150);
  }, []);

  return (
    <div ref={pageRef} className="clipboard-page">
      <div className="page-search">
        <SearchInput
          placeholder={t("clipboard.search")}
          value={search}
          onChange={handleSearchChange}
        />
      </div>

      <div className="clipboard-categories">
        {categories.map((c) => (
          <button
            key={c.key}
            className={`category-chip ${category === c.key ? "active" : ""}`}
            onClick={() => handleCategoryChange(c.key)}
          >
            {c.label}
          </button>
        ))}
      </div>

      {loading && records.length === 0 ? (
        <div className="clipboard-list">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="notification skeleton">
              <div className="notibar" />
              <div className="noticontent">
                <div className="notititle">
                  <div className="skeleton-line short" />
                </div>
                <div className="notibody">
                  <div
                    className="skeleton-line"
                    style={{ width: `${55 + ((i * 17) % 35)}%` }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="page-empty-compact">
          <div className="empty-icon-compact">{Icons.clipboard}</div>
          <span>{t("clipboard.empty")}</span>
        </div>
      ) : (
        <div
          ref={handleListRef}
          className="clipboard-list"
          onScroll={handleListScroll}
        >
          {filtered.map((r, i) => (
            <ClipboardCard
              key={r.id}
              record={r}
              index={i}
              getTypeLabel={getTypeLabel}
              onPaste={handlePaste}
              onDelete={handleDelete}
              onToggleFavorite={handleToggleFavorite}
              onThumbHover={handleThumbHover}
              onThumbLeave={handleThumbLeave}
            />
          ))}
          {hasMore && filtered.length > 0 && (
            <button
              className="clipboard-load-more"
              type="button"
              onClick={() => loadRecords(true)}
            >
              显示更多
            </button>
          )}
        </div>
      )}

      {showScrollTop && filtered.length > 0 && (
        <button
          className="clipboard-scroll-top"
          type="button"
          title={t("clipboard.scrollToTop")}
          aria-label={t("clipboard.scrollToTop")}
          onClick={handleScrollToTop}
        >
          <KeyboardArrowUpRoundedIcon />
        </button>
      )}

      {hoverPreview && (
        <div className="thumb-hover-overlay">
          <img src={hoverPreview.src} alt="" />
        </div>
      )}

    </div>
  );
}
