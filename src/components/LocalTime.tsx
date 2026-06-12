"use client";

import { useEffect, useState } from "react";

// Renders a UTC timestamp in the viewer's timezone. Rendered after mount to
// avoid a server/client hydration mismatch.
export default function LocalTime({
  iso,
  mode = "datetime",
}: {
  iso: string;
  mode?: "datetime" | "time";
}) {
  const [text, setText] = useState("");
  useEffect(() => {
    const d = new Date(iso);
    setText(
      mode === "time"
        ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : d.toLocaleString([], {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
    );
  }, [iso, mode]);
  return <span suppressHydrationWarning>{text || "…"}</span>;
}
