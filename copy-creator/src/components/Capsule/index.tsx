import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { ownEventSubscriptions } from "../../lib/eventSubscriptions";
import i18n from "../../i18n";
import { OPEN_LABEL_KEYS, DEFAULT_ICONS, type CapsuleKind, type CapsuleShowPayload } from "./types";

/** Keep in sync with the fade-out animation duration in styles/capsule.css. */
const FADE_OUT_MS = 200;
/** Physical-pixel drag threshold before a press counts as a move, not a click. */
const DRAG_THRESHOLD_PX = 6;

export default function Capsule() {
  const { t } = useTranslation();

  const [visible, setVisible] = useState(false);
  const [kind, setKind] = useState<CapsuleKind>("url");
  const [text, setText] = useState("");
  const [display, setDisplay] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [iconDataUri, setIconDataUri] = useState<string | null>(null);

  const visibleRef = useRef(false);
  const leavingRef = useRef(false);
  const kindRef = useRef<CapsuleKind>("url");
  const textRef = useRef("");
  const iconKindRef = useRef<CapsuleKind | null>(null);
  const iconCacheRef = useRef<Partial<Record<CapsuleKind, string | null>>>({});
  const deadlineRef = useRef(0);
  const remainingRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const fadeTimerRef = useRef<number | null>(null);
  // Drag state: the webview drives the window with start_dragging; the moved
  // flag distinguishes a real drag from a click on release.
  const pointerDownRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const draggedRef = useRef(false);
  const expandedRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const clearFadeTimer = useCallback(() => {
    if (fadeTimerRef.current !== null) {
      window.clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
  }, []);

  const resetLocal = useCallback(() => {
    clearTimer();
    clearFadeTimer();
    remainingRef.current = 0;
    visibleRef.current = false;
    leavingRef.current = false;
    pointerDownRef.current = null;
    draggedRef.current = false;
    expandedRef.current = false;
    setVisible(false);
    setLeaving(false);
    setHovered(false);
    setExpanded(false);
    setDragging(false);
  }, [clearTimer, clearFadeTimer]);

  const hideWindow = useCallback(() => {
    resetLocal();
    void invoke("capsule_hide").catch(() => {});
  }, [resetLocal]);

  const beginFadeOut = useCallback(() => {
    if (leavingRef.current || !visibleRef.current) return;
    leavingRef.current = true;
    clearTimer();
    setLeaving(true);
    fadeTimerRef.current = window.setTimeout(() => {
      fadeTimerRef.current = null;
      hideWindow();
    }, FADE_OUT_MS);
  }, [clearTimer, hideWindow]);

  const startCountdown = useCallback((durationMs: number) => {
    if (leavingRef.current) return;
    clearTimer();
    const duration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
    deadlineRef.current = Date.now() + duration;
    if (duration === 0) {
      beginFadeOut();
      return;
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      beginFadeOut();
    }, duration);
  }, [beginFadeOut, clearTimer]);

  const loadIcon = useCallback((targetKind: CapsuleKind) => {
    iconKindRef.current = targetKind;
    const cached = iconCacheRef.current[targetKind];
    if (cached !== undefined) {
      // Paint the known icon immediately, then re-read so a custom icon picked in
      // settings shows up on the next capsule without waiting for a kind change.
      setIconDataUri(cached);
    } else {
      // Show the bundled fallback right away instead of the previous kind's icon.
      setIconDataUri(null);
    }
    invoke<string | null>("capsule_icon_data_uri", { kind: targetKind })
      .then((uri) => {
        const value = typeof uri === "string" && uri.length > 0 ? uri : null;
        // Only a real image is cached. A null means "no custom icon yet", and the
        // setting may be filled in later, so the next show reads it again.
        if (value) iconCacheRef.current[targetKind] = value;
        else delete iconCacheRef.current[targetKind];
        // A newer capsule-show may have switched the kind while this was in flight.
        if (iconKindRef.current !== targetKind) return;
        setIconDataUri(value);
      })
      .catch(() => {
        if (iconKindRef.current === targetKind) setIconDataUri(null);
      });
  }, []);

  // The webview cannot grow past its own window; Rust resizes the native window
  // from the same anchor before the bubble is painted.
  const setExpandedState = useCallback((next: boolean) => {
    expandedRef.current = next;
    setExpanded(next);
    void invoke("capsule_set_expanded", { expanded: next }).catch(() => {});
  }, []);

  // Initial theme and language, then follow the main window for both.
  useEffect(() => {
    invoke<string>("get_setting", { key: "theme" }).then((theme) => {
      if (theme === "dark" || theme === "light") {
        document.documentElement.setAttribute("data-theme", theme);
      }
    }).catch(() => {});

    invoke<string>("get_setting", { key: "language" }).then((lang) => {
      if (lang && lang !== i18n.language) {
        i18n.changeLanguage(lang);
      }
    }).catch(() => {});

    const theme = listen<{ theme: string }>("theme-changed", (event) => {
      document.documentElement.setAttribute("data-theme", event.payload.theme);
    });

    const language = listen<{ language: string }>("language-changed", (event) => {
      if (event.payload.language !== i18n.language) {
        i18n.changeLanguage(event.payload.language);
      }
    });

    return ownEventSubscriptions([theme, language], console.error);
  }, []);

  // Capsule lifecycle: show/reset countdown, Esc to close.
  useEffect(() => {
    const show = listen<CapsuleShowPayload>("capsule-show", ({ payload }) => {
      kindRef.current = payload.kind;
      textRef.current = payload.text;
      setKind(payload.kind);
      setText(payload.text);
      setDisplay(payload.display);
      expandedRef.current = false;
      setExpanded(false);
      setLeaving(false);
      leavingRef.current = false;
      pointerDownRef.current = null;
      draggedRef.current = false;
      setDragging(false);
      clearFadeTimer();
      setVisible(true);
      visibleRef.current = true;
      // The window is created non-focusable, so focus may still sit elsewhere;
      // focusing the body is the only lever this webview has to receive keydown.
      document.body.focus();
      // Re-read the icon on every show so a custom icon chosen in settings is
      // picked up; the cached data URI keeps the first paint immediate.
      loadIcon(payload.kind);
      startCountdown(payload.durationMs);
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !visibleRef.current) return;
      event.preventDefault();
      hideWindow();
    };

    // Both targets are bound: depending on the compositor a non-focusable window
    // may deliver keydown to the document or only to the window.
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    const stopShow = ownEventSubscriptions([show], console.error);

    return () => {
      stopShow();
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
      clearTimer();
      clearFadeTimer();
    };
  }, [clearFadeTimer, clearTimer, hideWindow, loadIcon, startCountdown]);

  const handleMouseEnter = useCallback(() => {
    if (!visibleRef.current || leavingRef.current) return;
    setHovered(true);
    // Hovering pauses the countdown; remember the time that was left.
    if (timerRef.current !== null) {
      remainingRef.current = Math.max(0, deadlineRef.current - Date.now());
      clearTimer();
    }
  }, [clearTimer]);

  const handleMouseLeave = useCallback(() => {
    setHovered(false);
    if (expandedRef.current) setExpandedState(false);
    if (!visibleRef.current || leavingRef.current) return;
    // Resume from the remaining time instead of restarting the full duration.
    const remaining = remainingRef.current;
    remainingRef.current = 0;
    if (remaining > 0) startCountdown(remaining);
    else beginFadeOut();
  }, [beginFadeOut, setExpandedState, startCountdown]);

  const handleOpen = useCallback(() => {
    // Rust hides the capsule itself on success and also when the open fails, so a
    // rejection is expected here and only needs the local view reset.
    invoke("capsule_open", { kind: kindRef.current, text: textRef.current })
      .then(() => { resetLocal(); })
      .catch(() => { resetLocal(); });
  }, [resetLocal]);

  // Fixed-mode dragging. The pill body is draggable; buttons and the expanded
  // text stay click-only. start_dragging runs the native move loop, so the
  // release position is read afterwards instead of tracking pointermove.
  const handlePointerDown = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button") || target.closest(".capsule-expand")) return;
    pointerDownRef.current = { x: event.screenX, y: event.screenY, moved: false };
  }, []);

  const handlePointerMove = useCallback((event: React.PointerEvent) => {
    const down = pointerDownRef.current;
    if (!down || down.moved) return;
    const dx = event.screenX - down.x;
    const dy = event.screenY - down.y;
    if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
    down.moved = true;
    draggedRef.current = true;
    setDragging(true);
    // Pause the countdown while the pill is being moved.
    if (timerRef.current !== null) {
      remainingRef.current = Math.max(0, deadlineRef.current - Date.now());
      clearTimer();
    }
    void getCurrentWindow().startDragging().catch(() => {});
  }, [clearTimer]);

  const handlePointerUp = useCallback(() => {
    const down = pointerDownRef.current;
    pointerDownRef.current = null;
    if (!down || !down.moved) {
      setDragging(false);
      return;
    }
    setDragging(false);
    // The window has reached its drop position; persist it for the fixed mode.
    void getCurrentWindow().outerPosition()
      .then((position) => invoke("capsule_save_fixed_position", {
        x: position.x, y: position.y,
      }))
      .catch(() => {});
  }, []);

  if (!visible) return null;

  return (
    <div className="capsule-root">
      <div
        className={`capsule${leaving ? " capsule-leaving" : ""}${hovered ? " capsule-hovered" : ""}${dragging ? " capsule-dragging" : ""}`}
        data-capsule-kind={kind}
        data-expanded={expanded ? "true" : "false"}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <div className="capsule-row">
          <img
            className={`capsule-icon${iconDataUri ? " capsule-icon-custom" : " capsule-icon-default"}`}
            src={iconDataUri ?? DEFAULT_ICONS[kind]}
            alt=""
            draggable={false}
          />
          <span
            className="capsule-text"
            title={display || text}
            onClick={() => setExpandedState(!expandedRef.current)}
          >{display || text}</span>
          <button type="button" className="capsule-action" onClick={handleOpen}>
            {t(OPEN_LABEL_KEYS[kind])}
          </button>
          <button
            type="button"
            className="capsule-close"
            onClick={hideWindow}
            aria-label={t("capsule.close")}
            title={t("capsule.close")}
          >
            <svg className="capsule-close-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        {expanded && (
          <div className="capsule-expand" role="region" aria-label={t("capsule.expand")}>
            <div className="capsule-expand-text" tabIndex={0}>{text}</div>
          </div>
        )}
      </div>
    </div>
  );
}
