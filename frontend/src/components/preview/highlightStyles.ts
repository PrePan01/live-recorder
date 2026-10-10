import type { CSSProperties } from "react";

export const styles = {
  menu: {
    width: 310,
    padding: 14,
    borderRadius: 10,
    background: "#fff",
    boxShadow: "0 10px 28px rgba(0,0,0,.16)",
  },
  secondaryText: { fontSize: 12 },
  clearButton: { paddingInline: 3, height: 20 },
  bufferedTime: {
    fontSize: 24,
    lineHeight: 1.25,
    fontWeight: 650,
    color: "#0958d9",
    marginTop: 2,
  },
  divider: {
    height: 1,
    background: "#f0f0f0",
    margin: "12px 0",
  },
  sectionTitle: { fontSize: 13 },
  quickButtons: {
    display: "flex",
    marginTop: 8,
    marginBottom: 12,
  },
  fill: { flex: 1 },
  row: { display: "flex" },
  fillTimeButton: { paddingInline: 5 },
  actionButton: { width: 100 },
} satisfies Record<string, CSSProperties>;
