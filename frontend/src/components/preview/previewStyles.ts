import type { CSSProperties } from "react";

export const styles = {
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    paddingRight: 8,
  },
  body: { display: "flex", flexDirection: "column", height: "100%" },
  content: {
    flex: "1 1 auto",
    minHeight: 0,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  playerSlot: {
    position: "absolute",
    inset: 0,
    background: "#000",
    overflow: "hidden",
    willChange: "width, height",
  },
  footer: {
    flexShrink: 0,
    marginTop: 12,
    textAlign: "center",
  },
  actionButton: { width: 100 },
} satisfies Record<string, CSSProperties>;
