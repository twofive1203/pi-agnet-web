"use client";

import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Design-system tooltip that replaces the browser-native `title` popup.
 *
 * Renders through a portal so it is never clipped by the top bar's
 * `overflow: hidden`, picks the side with the most viewport room, and
 * inherits the active theme via CSS variables.
 */

type TooltipPosition = "top" | "bottom" | "left" | "right";

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  /** Preferred side; falls back to the opposite when space is tight. */
  position?: TooltipPosition;
  /** Hover delay in ms before the tooltip appears. */
  delay?: number;
  className?: string;
}

const GAP = 8;
const VIEWPORT_MARGIN = 8;

function opposite(pos: TooltipPosition): TooltipPosition {
  switch (pos) {
    case "top": return "bottom";
    case "bottom": return "top";
    case "left": return "right";
    case "right": return "left";
  }
}

export default function Tooltip({
  content,
  children,
  position = "top",
  delay = 300,
  className,
}: TooltipProps) {
  const tooltipId = useId();
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState({ left: 0, top: 0 });
  const [actualPosition, setActualPosition] = useState<TooltipPosition>(position);
  const anchorRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const touchTimerRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    if (touchTimerRef.current !== null) {
      window.clearTimeout(touchTimerRef.current);
      touchTimerRef.current = null;
    }
  }, []);

  const hide = useCallback(() => {
    clearTimers();
    setVisible(false);
  }, [clearTimers]);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const tip = tooltipRef.current;
    const tipWidth = tip?.offsetWidth ?? 160;
    const tipHeight = tip?.offsetHeight ?? 32;

    let pos = position;
    const fits = (p: TooltipPosition) => {
      switch (p) {
        case "top": return rect.top >= tipHeight + GAP + VIEWPORT_MARGIN;
        case "bottom": return window.innerHeight - rect.bottom >= tipHeight + GAP + VIEWPORT_MARGIN;
        case "left": return rect.left >= tipWidth + GAP + VIEWPORT_MARGIN;
        case "right": return window.innerWidth - rect.right >= tipWidth + GAP + VIEWPORT_MARGIN;
      }
    };
    if (!fits(pos) && fits(opposite(pos))) pos = opposite(pos);

    let left = 0;
    let top = 0;
    switch (pos) {
      case "top":
        left = rect.left + rect.width / 2 - tipWidth / 2;
        top = rect.top - tipHeight - GAP;
        break;
      case "bottom":
        left = rect.left + rect.width / 2 - tipWidth / 2;
        top = rect.bottom + GAP;
        break;
      case "left":
        left = rect.left - tipWidth - GAP;
        top = rect.top + rect.height / 2 - tipHeight / 2;
        break;
      case "right":
        left = rect.right + GAP;
        top = rect.top + rect.height / 2 - tipHeight / 2;
        break;
    }

    // Keep the bubble inside the viewport; the arrow stays centered on the
    // anchor via a CSS offset so slight clamping never detaches the two.
    const clampedLeft = Math.min(
      Math.max(left, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, window.innerWidth - tipWidth - VIEWPORT_MARGIN),
    );
    const arrowOffset = rect.left + rect.width / 2 - clampedLeft;
    tooltipRef.current?.style.setProperty("--tooltip-arrow-offset", `${arrowOffset}px`);

    setActualPosition(pos);
    setCoords({ left: clampedLeft, top: Math.max(top, VIEWPORT_MARGIN) });
  }, [position]);

  const show = useCallback((withDelay: boolean) => {
    clearTimers();
    if (withDelay) {
      showTimerRef.current = window.setTimeout(() => setVisible(true), delay);
    } else {
      setVisible(true);
    }
  }, [clearTimers, delay]);

  useEffect(() => clearTimers, [clearTimers]);

  useEffect(() => {
    if (!visible) return;
    updatePosition();
    const reposition = () => updatePosition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [visible, updatePosition]);

  if (!content) return children;

  const child = React.Children.only(children) as React.ReactElement<Record<string, unknown>>;
  const childProps = child.props;

  const composeHandler = (original: unknown, handler: (e: React.SyntheticEvent) => void) =>
    (e: React.SyntheticEvent) => {
      if (typeof original === "function") (original as (ev: React.SyntheticEvent) => void)(e);
      handler(e);
    };

  const setAnchorRef = (node: HTMLElement | null) => {
    anchorRef.current = node;
    const originalRef = (child as { ref?: React.Ref<HTMLElement> }).ref;
    if (typeof originalRef === "function") originalRef(node);
    else if (originalRef && typeof originalRef === "object") {
      (originalRef as React.MutableRefObject<HTMLElement | null>).current = node;
    }
  };

  const trigger = React.cloneElement(child, {
    ref: setAnchorRef,
    "aria-describedby": visible ? tooltipId : (childProps["aria-describedby"] as string | undefined),
    onMouseEnter: composeHandler(childProps.onMouseEnter, () => show(true)),
    onMouseLeave: composeHandler(childProps.onMouseLeave, hide),
    onFocus: composeHandler(childProps.onFocus, () => show(false)),
    onBlur: composeHandler(childProps.onBlur, hide),
    onClick: composeHandler(childProps.onClick, hide),
    onTouchStart: composeHandler(childProps.onTouchStart, () => {
      show(true);
      touchTimerRef.current = window.setTimeout(hide, 2400);
    }),
  } as Record<string, unknown>);

  return (
    <>
      {trigger}
      {visible &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            className={`app-tooltip app-tooltip-${actualPosition}${className ? ` ${className}` : ""}`}
            style={{ left: coords.left, top: coords.top }}
          >
            {content}
            <span className="app-tooltip-arrow" aria-hidden="true" />
          </div>,
          document.body,
        )}
    </>
  );
}
