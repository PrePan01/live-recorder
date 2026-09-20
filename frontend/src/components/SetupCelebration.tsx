import { useCallback, useEffect, useState, type CSSProperties } from "react";

const CELEBRATION_EVENT = "lr:setup-celebration";
const CELEBRATION_MARKER = "lr-setup-celebration";

const COLORS = ["#ff4d6d", "#ffbe0b", "#06d6a0", "#3a86ff", "#8338ec", "#fb5607"];
const PARTICLES = Array.from({ length: 220 }, (_, index) => {
  const burst = index % 5;
  const angle = ((index * 47) % 360) * (Math.PI / 180);
  const distance = 160 + ((index * 29) % 310);
  return {
    id: index,
    left: `${10 + burst * 20 + ((index * 13) % 10)}%`,
    top: `${18 + ((index * 17) % 34)}%`,
    x: `${Math.cos(angle) * distance}px`,
    y: `${Math.sin(angle) * distance + 310}px`,
    rotate: `${360 + ((index * 71) % 540)}deg`,
    delay: `${burst * 0.12 + ((index % 6) * 0.035)}s`,
    color: COLORS[index % COLORS.length],
  };
});

/** Starts the one-time celebration after a successful first-time setup. */
export function playSetupCelebration(): void {
  try {
    sessionStorage.setItem(CELEBRATION_MARKER, "1");
  } catch {
    // The in-memory event still plays when storage is unavailable.
  }
  window.dispatchEvent(new Event(CELEBRATION_EVENT));
}

export default function SetupCelebration() {
  const [active, setActive] = useState(false);

  const play = useCallback(() => {
    setActive(true);
    window.setTimeout(() => setActive(false), 2_300);
  }, []);

  useEffect(() => {
    const resume = () => {
      try {
        if (sessionStorage.getItem(CELEBRATION_MARKER) !== "1") return;
        sessionStorage.removeItem(CELEBRATION_MARKER);
      } catch {
        // The event remains sufficient when sessionStorage is unavailable.
      }
      play();
    };
    window.addEventListener(CELEBRATION_EVENT, resume);
    resume();
    return () => window.removeEventListener(CELEBRATION_EVENT, resume);
  }, [play]);

  if (!active) return null;

  return (
    <div className="lr-setup-celebration" aria-hidden="true">
      {PARTICLES.map((particle) => (
        <span
          className="lr-setup-celebration__particle"
          key={particle.id}
          style={
            {
              left: particle.left,
              top: particle.top,
              backgroundColor: particle.color,
              animationDelay: particle.delay,
              "--lr-confetti-x": particle.x,
              "--lr-confetti-y": particle.y,
              "--lr-confetti-rotate": particle.rotate,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
