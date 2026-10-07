import type { ReactNode } from "react";

/** Manual order reads left-to-right across regular rows. */
export default function RoomGrid({ children }: { children: ReactNode }) {
  return <div className="lr-room-grid">{children}</div>;
}
