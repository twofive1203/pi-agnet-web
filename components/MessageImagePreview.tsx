"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/components/I18nProvider";

interface Props {
  src: string;
}

interface TouchStart {
  pointerId: number;
  x: number;
  y: number;
}

interface ZoomState {
  scale: number;
  x: number;
  y: number;
}

const MAX_TAP_DISTANCE = 8;
const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const INITIAL_ZOOM: ZoomState = { scale: MIN_ZOOM, x: 0, y: 0 };

export function MessageImagePreview({ src }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState<ZoomState>(INITIAL_ZOOM);
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const lightboxImageRef = useRef<HTMLImageElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const touchStartRef = useRef<TouchStart | null>(null);

  const close = useCallback(() => {
    setZoom(INITIAL_ZOOM);
    setOpen(false);
  }, []);
  const openPreview = useCallback(() => {
    setZoom(INITIAL_ZOOM);
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    const trigger = triggerRef.current;
    document.body.style.overflow = "hidden";
    const focusFrame = requestAnimationFrame(() => closeButtonRef.current?.focus());

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (trigger?.isConnected) requestAnimationFrame(() => trigger.focus());
    };
  }, [close, open]);

  const openFromKeyboard = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openPreview();
  };

  const recordTouchStart = (event: PointerEvent<HTMLSpanElement>) => {
    if (event.pointerType === "mouse") return;
    touchStartRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
  };

  const openFromTouch = (event: PointerEvent<HTMLSpanElement>) => {
    if (event.pointerType === "mouse") return;
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start || start.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > MAX_TAP_DISTANCE) return;
    openPreview();
  };

  const zoomAtCursor = useCallback((event: globalThis.WheelEvent) => {
    event.preventDefault();
    const image = lightboxImageRef.current;
    if (!image) return;
    const rect = image.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const deltaUnit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    const factor = Math.exp(-event.deltaY * deltaUnit * WHEEL_ZOOM_SENSITIVITY);
    const cursorX = event.clientX;
    const cursorY = event.clientY;
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    setZoom((current) => {
      const nextScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.scale * factor));
      if (nextScale === MIN_ZOOM) return INITIAL_ZOOM;
      if (nextScale === current.scale) return current;

      const scaleRatio = nextScale / current.scale;
      return {
        scale: nextScale,
        x: current.x + (cursorX - centerX) * (1 - scaleRatio),
        y: current.y + (cursorY - centerY) * (1 - scaleRatio),
      };
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const image = lightboxImageRef.current;
    if (!image) return;
    image.addEventListener("wheel", zoomAtCursor, { passive: false });
    return () => image.removeEventListener("wheel", zoomAtCursor);
  }, [open, zoomAtCursor]);

  const lightbox = open && typeof document !== "undefined"
    ? createPortal(
        <div
          className="message-image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={t("chat.imagePreviewDialog")}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
          onKeyDown={(event) => {
            if (event.key === "Tab") {
              event.preventDefault();
              closeButtonRef.current?.focus();
            }
          }}
        >
          <div className="message-image-lightbox-content">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={lightboxImageRef}
              src={src}
              alt=""
              className="message-image-lightbox-image"
              draggable={false}
              title={t("chat.imagePreviewZoomHint")}
              style={{ transform: `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})` }}
            />
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="message-image-lightbox-close"
            onClick={close}
            aria-label={t("chat.imagePreviewClose")}
            title={t("chat.imagePreviewClose")}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <line x1="5" y1="5" x2="19" y2="19" />
              <line x1="19" y1="5" x2="5" y2="19" />
            </svg>
          </button>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <span
        ref={triggerRef}
        className="message-media-trigger"
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-label={t("chat.imagePreviewOpen")}
        title={t("chat.imagePreviewOpenHint")}
        onDoubleClick={openPreview}
        onKeyDown={openFromKeyboard}
        onPointerDown={recordTouchStart}
        onPointerUp={openFromTouch}
        onPointerCancel={() => { touchStartRef.current = null; }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" className="message-media-preview" draggable={false} />
      </span>
      {lightbox}
    </>
  );
}
