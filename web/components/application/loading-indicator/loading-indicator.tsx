"use client";

import { useEffect } from "react";
import type {} from "ldrs";

type LoadingIndicatorProps = {
  type?: "line-spinner";
  size?: "sm" | "md" | "lg" | "xl";
  color?: string;
};

const SIZE_MAP: Record<NonNullable<LoadingIndicatorProps["size"]>, number> = {
  sm: 18,
  md: 28,
  lg: 36,
  xl: 44,
};

export function LoadingIndicator({
  type = "line-spinner",
  size = "md",
  color = "currentColor",
}: LoadingIndicatorProps) {
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    let cancelled = false;

    import("ldrs")
      .then(({ lineSpinner }) => {
        if (cancelled) return;
        if (!customElements.get("l-line-spinner")) {
          lineSpinner.register();
        }
      })
      .catch((error) => {
        console.error("Failed to load ldrs", error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const resolvedSize = SIZE_MAP[size] ?? SIZE_MAP.md;

  if (type === "line-spinner") {
    return (
      <l-line-spinner
        size={resolvedSize}
        stroke={3}
        speed={1.2}
        color={color}
        aria-label="Chargement"
      />
    );
  }

  return null;
}
