import { useEffect, useRef, useState, useCallback, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { listen, emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { useClipboardStore, type ClipType } from "../../stores/clipboardStore";
import { getStorageIdentity, isCurrentStorageIdentity, invokeStorage, onStorageIdentity } from "../../lib/storageIdentity";
import { RadialNotes, RADIAL_ALL, RADIAL_UNGROUPED } from "../../lib/radialNotes";
import { requestRadialFlush, type RadialFlushReply } from "../../lib/radialNoteFlush";
import { ownEventSubscriptions } from "../../lib/eventSubscriptions";
import { useHoverSwitch } from "./useHoverSwitch";
import { HoverProgress } from "./HoverProgress";
import i18n from "../../i18n";

type TabKey = "clipboard" | "phrases";

const HOVER_DELAY = 500;
const MAX_ITEMS = 2000;
const EMPTY_RECORDS: ReturnType<typeof useClipboardStore.getState>["records"] = [];
const radialNotes = new RadialNotes({
  epoch: getStorageIdentity, current: isCurrentStorageIdentity, invoke, paste: invokeStorage,
  flush: (id, storageEpoch) => requestRadialFlush({ id, storageEpoch, requestId: crypto.randomUUID() }, {
    listen: callback => listen<RadialFlushReply>("radial-note-flushed", ({ payload }) => callback(payload)),
    send: request => emitTo("main", "radial-note-flush", request),
  }),
});

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${month}/${day} ${hours}:${minutes}`;
}

function ImageThumb({ recordId }: { recordId: string }) {
  const [src, setSrc] = useState("");
  const record = useClipboardStore((state) => state.records.find((r) => r.id === recordId));
  const getThumbnail = useClipboardStore((state) => state.getThumbnail);
  const [visible, setVisible] = useState(false);
  const element = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!element.current) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "80px" });
    observer.observe(element.current); return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !record || record.type !== "image") return;
    const abort = new AbortController();
    getThumbnail(record, abort.signal).then((url) => {
      if (!abort.signal.aborted && url) setSrc(url);
    });
    return () => { abort.abort(); setSrc(""); };
  }, [record, visible, getThumbnail]);

  return (
    <span ref={element}>
    {!visible || !src ? "…" :
    <img
      src={src}
      alt=""
      style={{ width: 48, height: 36, objectFit: "cover", borderRadius: 5 }}
    />
    }</span>
  );
}

export default function RadialMenu() {
  const { t } = useTranslation();

  const [visible, setVisible] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("clipboard");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [clipboardCategory, setClipboardCategory] = useState<ClipType>("all");
  const notes = useSyncExternalStore(radialNotes.subscribe, radialNotes.getSnapshot);
  const phraseGroupId = notes.group;
  const [pasteFailed, setPasteFailed] = useState(false);

  const isRightDownRef = useRef(false);
  const pasteInFlightRef = useRef(false);
  const visibleRef = useRef(false);
  const showTimestampRef = useRef(0);
  const selectedItemIdRef = useRef<string | null>(null);
  const activeTabRef = useRef<TabKey>("clipboard");
  const clipboardCategoryRef = useRef<ClipType>("all");
  const phraseGroupIdRef = useRef<string | null>(null);
  const startPosRef = useRef({ x: 0, y: 0 });

  useEffect(() => { visibleRef.current = visible; }, [visible]);
  useEffect(() => { selectedItemIdRef.current = selectedItemId; }, [selectedItemId]);
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);
  useEffect(() => { clipboardCategoryRef.current = clipboardCategory; }, [clipboardCategory]);
  useEffect(() => { phraseGroupIdRef.current = phraseGroupId; }, [phraseGroupId]);

  useEffect(() => {
    // Initial theme load
    invoke<string>("get_setting", { key: "theme" }).then((theme) => {
      if (theme === "dark" || theme === "light") {
        document.documentElement.setAttribute("data-theme", theme);
      }
    }).catch(() => {});

    // Initial language load
    invoke<string>("get_setting", { key: "language" }).then((lang) => {
      if (lang && lang !== i18n.language) {
        i18n.changeLanguage(lang);
      }
    }).catch(() => {});

    // Install lightweight listeners; defer queries and images until shown.
    useClipboardStore.getState().init();

    // Listen for theme changes from the main window
    const theme = listen<{ theme: string }>("theme-changed", (e) => {
      document.documentElement.setAttribute("data-theme", e.payload.theme);
    });

    // Listen for language changes from the main window
    const language = listen<{ language: string }>("language-changed", (e) => {
      if (e.payload.language !== i18n.language) {
        i18n.changeLanguage(e.payload.language);
      }
    });
    return ownEventSubscriptions([theme, language], console.error);
  }, []);

  const handleTabSwitch = useCallback((key: string) => {
    const tab = key as TabKey;
    activeTabRef.current = tab;
    setActiveTab(tab);
    setSelectedItemId(null);
    selectedItemIdRef.current = null;
  }, []);

  const handleCategorySwitch = useCallback((key: string) => {
    if (activeTabRef.current === "clipboard") {
      setClipboardCategory(key as ClipType);
      clipboardCategoryRef.current = key as ClipType;
    } else {
      phraseGroupIdRef.current = key;
      void radialNotes.select(key);
    }
    setSelectedItemId(null);
    selectedItemIdRef.current = null;
  }, []);

  const navSwitch = useHoverSwitch(handleTabSwitch, HOVER_DELAY);
  const categorySwitch = useHoverSwitch(handleCategorySwitch, HOVER_DELAY);

  const navEnterRef = useRef(navSwitch.handleEnter);
  const navLeaveRef = useRef(navSwitch.handleLeave);
  const catEnterRef = useRef(categorySwitch.handleEnter);
  const catLeaveRef = useRef(categorySwitch.handleLeave);
  useEffect(() => {
    navEnterRef.current = navSwitch.handleEnter; navLeaveRef.current = navSwitch.handleLeave;
    catEnterRef.current = categorySwitch.handleEnter; catLeaveRef.current = categorySwitch.handleLeave;
  }, [navSwitch.handleEnter, navSwitch.handleLeave, categorySwitch.handleEnter, categorySwitch.handleLeave]);

  const resetState = useCallback(() => {
    useClipboardStore.getState().setVisible(false);
    radialNotes.hide();
    isRightDownRef.current = false;
    visibleRef.current = false;
    setVisible(false);
    setSelectedItemId(null);
    selectedItemIdRef.current = null;
    navLeaveRef.current();
    catLeaveRef.current();
  }, []);

  const updateHoverFromPoint = useCallback((cssX: number, cssY: number) => {
    const el = document.elementFromPoint(cssX, cssY);
    if (!el) {
      selectedItemIdRef.current = null;
      setSelectedItemId(null);
      navLeaveRef.current();
      catLeaveRef.current();
      return;
    }

    const itemEl = (el as HTMLElement).closest("[data-radial-item-id]");
    const navEl = (el as HTMLElement).closest("[data-radial-nav]");
    const catEl = (el as HTMLElement).closest("[data-radial-category]");

    if (itemEl) {
      const id = itemEl.getAttribute("data-radial-item-id");
      selectedItemIdRef.current = id;
      setSelectedItemId(id);
      navLeaveRef.current();
      catLeaveRef.current();
    } else if (navEl) {
      const key = navEl.getAttribute("data-radial-nav");
      if (key && key !== activeTabRef.current) {
        navEnterRef.current(key);
      } else {
        navLeaveRef.current();
      }
      catLeaveRef.current();
      selectedItemIdRef.current = null;
      setSelectedItemId(null);
    } else if (catEl) {
      const key = catEl.getAttribute("data-radial-category");
      const activeCat = activeTabRef.current === "clipboard"
        ? clipboardCategoryRef.current
        : phraseGroupIdRef.current;
      if (key && key !== activeCat) {
        catEnterRef.current(key);
      } else {
        catLeaveRef.current();
      }
      navLeaveRef.current();
      selectedItemIdRef.current = null;
      setSelectedItemId(null);
    } else {
      selectedItemIdRef.current = null;
      setSelectedItemId(null);
      navLeaveRef.current();
      catLeaveRef.current();
    }
  }, []);

  useEffect(() => {
    const down = listen<{ x: number; y: number; theme: string }>("radial-menu-down", (e) => {
      if (pasteInFlightRef.current) return;
      // Apply theme synchronously from backend-provided value.
      document.documentElement.setAttribute("data-theme", e.payload.theme);
      isRightDownRef.current = true;
      showTimestampRef.current = Date.now();
      startPosRef.current = { x: e.payload.x, y: e.payload.y };
      visibleRef.current = true;
      setVisible(true);
      useClipboardStore.getState().setVisible(true);
      setPasteFailed(false);
      void radialNotes.show();
      useClipboardStore.getState().loadRecords();
    });

      const move = listen<{ x: number; y: number }>("radial-menu-move", (e) => {
        if (!isRightDownRef.current) return;

        const cssX = e.payload.x;
        const cssY = e.payload.y;

        if (!visibleRef.current) {
          showTimestampRef.current = Date.now();
          visibleRef.current = true;
          setVisible(true);
        }

        updateHoverFromPoint(cssX, cssY);
      });

    const up = listen("radial-menu-up", async () => {
      if (!isRightDownRef.current) return;
      isRightDownRef.current = false;
      pasteInFlightRef.current = true;
      try {
        if (visibleRef.current && selectedItemIdRef.current) {
          const itemId = selectedItemIdRef.current;
          if (activeTabRef.current === "phrases") {
            const state = radialNotes.getSnapshot();
            if (state.epoch !== null && state.records.some(note => note.id === itemId)) await radialNotes.paste(itemId, state.epoch);
          } else {
            const { records, pasteRecord } = useClipboardStore.getState();
            const record = records.find((r) => r.id === itemId);
            if (record) await pasteRecord(record);
          }
        }
        resetState();
        await getCurrentWindow().hide();
      } catch { setPasteFailed(true); }
      finally { pasteInFlightRef.current = false; }
    });
    const changes = ["phrase-groups-changed", "notes-changed", "notes-pruned"].map(name => listen<{ storage_epoch: number }>(name, ({ payload }) => {
      if (isCurrentStorageIdentity(payload.storage_epoch)) { selectedItemIdRef.current = null; setSelectedItemId(null); void radialNotes.refresh(); }
    }));
    const stopEvents = ownEventSubscriptions([down, move, up, ...changes], console.error);
    const stopIdentity = onStorageIdentity(() => { selectedItemIdRef.current = null; setSelectedItemId(null); radialNotes.hide(); if (visibleRef.current) void radialNotes.show(); });

    const handleContextMenu = (e: Event) => {
      e.preventDefault();
    };

    const handleWheel = (e: WheelEvent) => {
      if (!isRightDownRef.current || !visibleRef.current) return;

      e.preventDefault();
      e.stopPropagation();

      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el) return;

      const catContainer = (el as HTMLElement).closest("[data-radial-categories]");
      if (catContainer) {
        catContainer.scrollLeft += e.deltaY;
        return;
      }

      const listContainer = (el as HTMLElement).closest("[data-radial-list]");
      if (listContainer) {
        listContainer.scrollTop += e.deltaY;
      }
    };

    const handleBlur = () => {
      if (visibleRef.current) {
        // Ignore blurs within 1s of show — compositor initialization
        // can cause spurious focus/blur on first show of transparent window.
        if (Date.now() - showTimestampRef.current < 1000) return;
        resetState();
        getCurrentWindow().hide();
      }
    };

    document.addEventListener("contextmenu", handleContextMenu, true);
    document.addEventListener("wheel", handleWheel, { passive: false });
    window.addEventListener("blur", handleBlur);

    return () => {
      stopEvents(); stopIdentity(); radialNotes.hide();
      document.removeEventListener("contextmenu", handleContextMenu, true);
      document.removeEventListener("wheel", handleWheel);
      window.removeEventListener("blur", handleBlur);
    };
  }, [resetState, updateHoverFromPoint]);

  const records = useClipboardStore((s) => visible ? s.records : EMPTY_RECORDS);
  const phraseGroups = notes.groups;

  const filteredRecords = clipboardCategory === "all"
    ? records
    : clipboardCategory === "apikey"
      ? records.filter((r) => r.is_api_key)
      : records.filter((r) => r.type === clipboardCategory);

  const items = activeTab === "clipboard"
    ? filteredRecords.slice(0, MAX_ITEMS).map((r) => ({
        id: r.id,
        content: r.type === "image"
          ? `[${t("clipboard.image")}]`
          : r.type === "file"
            ? r.content.replace(/\\/g, "/").split("/").pop() || r.content
            : r.is_api_key
              ? r.key_preview || r.content
              : r.content,
        type: r.is_api_key ? "apikey" : r.type,
        createdAt: r.created_at,
      }))
    : notes.records.map((p) => ({
        id: p.id,
        content: p.summary,
        type: "phrase" as string,
        title: p.title,
      }));

  const categories = activeTab === "clipboard"
    ? [
        { key: "all", label: t("clipboard.all") },
        { key: "text", label: t("clipboard.text") },
        { key: "image", label: t("clipboard.image") },
        { key: "link", label: t("clipboard.link") },
        { key: "explorer", label: t("clipboard.explorer") },
        { key: "file", label: t("clipboard.file") },
        { key: "apikey", label: t("clipboard.apikey") },
      ]
    : [{ key: RADIAL_ALL, label: t("clipboard.all") }, { key: RADIAL_UNGROUPED, label: t("notes.ungrouped") }, ...phraseGroups.map((g) => ({
        key: g.id,
        label: g.name,
      }))];

  const activeCategory = activeTab === "clipboard" ? clipboardCategory : phraseGroupId ?? phraseGroups[0]?.id;

  if (!visible) return null;
  return (
    <div className="radial-menu-overlay">
      <div className="radial-menu-popup">
        <div className="radial-menu-nav">
          {(["clipboard", "phrases"] as TabKey[]).map((tab) => (
            <button
              key={tab}
              className={`radial-menu-nav-tab ${activeTab === tab ? "active" : ""}`}
              data-radial-nav={tab}
            >
              <span className="radial-menu-nav-label">{t(`tabs.${tab}`)}</span>
              {navSwitch.progressKey === tab && (
                <HoverProgress progress={navSwitch.progress} />
              )}
            </button>
          ))}
        </div>

        {categories.length > 0 && (
          <div className="radial-menu-categories" data-radial-categories>
            {categories.map((cat) => (
              <button
                key={cat.key}
                className={`radial-menu-category-chip ${activeCategory === cat.key ? "active" : ""}`}
                data-radial-category={cat.key}
              >
                {cat.label}
                {categorySwitch.progressKey === cat.key && (
                  <HoverProgress progress={categorySwitch.progress} />
                )}
              </button>
            ))}
          </div>
        )}

        {pasteFailed && <button type="button" className="radial-menu-empty" onClick={() => { resetState(); void getCurrentWindow().hide(); }}>{t("radialMenu.pasteFailed")}</button>}
        <div className="radial-menu-list" data-radial-list onScroll={event => {
          const element = event.currentTarget;
          if (activeTab === "phrases" && element.scrollHeight - element.scrollTop - element.clientHeight < 80) void radialNotes.more();
        }}>
          {items.length === 0 ? (
            <div className="radial-menu-empty">{t(activeTab === "phrases" && notes.error ? notes.error : activeTab === "phrases" && notes.loading ? "radialMenu.loading" : "radialMenu.empty")}</div>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                className={`radial-menu-item ${selectedItemId === item.id ? "selected" : ""}`}
                data-radial-item-id={item.id}
              >
                {item.type === "image" ? (
                  <ImageThumb recordId={item.id} />
                ) : (
                  <span className="radial-menu-item-text">
                    {item.content.length > 300
                      ? item.content.slice(0, 300) + "…"
                      : item.content}
                  </span>
                )}
                {"createdAt" in item && item.createdAt && (
                  <span className="radial-menu-item-time">{formatTime(item.createdAt)}</span>
                )}
                {"title" in item && item.title && (
                  <span className="radial-menu-item-remark">{item.title}</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
