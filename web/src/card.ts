// Output cards: what a run printed, on a card over the page, one per cell.
// Cards are not modal. A card stays where it is dropped. Dragged near a screen
// edge it is pulled flush onto it and sticks there; pushed on, well past the
// edge, it breaks free and is thrown away. A hard flick, its X, or Escape (the
// frontmost card) also throw it away.
//
// A card is two elements: the outer one is positioned (a translate set here),
// the inner one is animated (pop-in, bump, tilt). A CSS animation overrides
// inline styles while it runs, so position and animation must not share an
// element.

export interface Output {
  title: string;
  /// Everything the run produced: what it printed, then `exit N` or a diagnostic.
  text: string;
  failed: boolean;
}

type Edge = "left" | "right" | "top" | "bottom";

interface Card {
  pos: HTMLElement;
  body: HTMLElement;
  x: number;
  y: number;
  dock: Edge | null;
}

/// Gap between a docked card and its edge.
const MARGIN = 12;
/// A card whose side comes this close to an edge is pulled onto it.
const SNAP = 120;
/// A card pushed past an edge by this share of its size is thrown away.
const PUSH_OUT = 0.4;
/// Above this release speed (px/ms) a drag is a throw from anywhere.
const FLICK_SPEED = 1.4;
/// Lines that appear one after another; the rest come with the last of them.
const STAGGERED_LINES = 24;

const cards = new Map<string, Card>();
let raised = 30;

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function stopAnimations(c: Card): void {
  for (const a of c.body.getAnimations()) a.cancel();
  c.body.classList.remove("bump");
}

function place(c: Card, x: number, y: number, ms = 0, easing = "cubic-bezier(.2, 1.3, .4, 1)"): void {
  c.x = x;
  c.y = y;
  c.pos.style.transition = ms && !reducedMotion() ? `transform ${ms}ms ${easing}` : "none";
  c.pos.style.transform = `translate(${x}px, ${y}px)`;
}

function raise(c: Card): void {
  c.pos.style.zIndex = String(++raised);
}

/// Where a card at (x, y) docked at `edge` sits, keeping its place along it.
function docked(c: Card, edge: Edge, x = c.x, y = c.y): [number, number] {
  const w = c.pos.offsetWidth, h = c.pos.offsetHeight;
  const clampX = Math.min(Math.max(x, MARGIN), Math.max(MARGIN, innerWidth - w - MARGIN));
  const clampY = Math.min(Math.max(y, MARGIN), Math.max(MARGIN, innerHeight - h - MARGIN));
  switch (edge) {
    case "left": return [MARGIN, clampY];
    case "right": return [innerWidth - w - MARGIN, clampY];
    case "top": return [clampX, MARGIN];
    case "bottom": return [clampX, innerHeight - h - MARGIN];
  }
}

/// The edge a card at (x, y) is nearest, how far inside it its side is
/// (negative once past it), and the card's size across that edge.
function nearest(c: Card, x: number, y: number): { edge: Edge; gap: number; size: number } {
  const w = c.pos.offsetWidth, h = c.pos.offsetHeight;
  const gaps: [Edge, number, number][] = [
    ["left", x, w], ["right", innerWidth - x - w, w], ["top", y, h], ["bottom", innerHeight - y - h, h],
  ];
  gaps.sort((a, b) => a[1] / a[2] - b[1] / b[2]);
  const [edge, gap, size] = gaps[0];
  return { edge, gap, size };
}

export function showOutput(key: string, o: Output): void {
  const lines = o.text.replace(/\n$/, "").split("\n");
  const exit = /^exit (-?\d+)$/.exec(lines[lines.length - 1] ?? "");
  const printed = exit ? lines.slice(0, -1) : lines;
  const status = o.failed ? "error" : exit ? `exit ${exit[1]}` : "done";
  const ok = !o.failed && (!exit || exit[1] === "0");

  let c = cards.get(key);
  const fresh = !c;
  if (!c) {
    c = create(key);
    cards.set(key, c);
  }
  const body = c.body;
  (body.querySelector(".card-title") as HTMLElement).textContent = o.title;
  const badge = body.querySelector(".card-status") as HTMLElement;
  badge.textContent = status;
  badge.className = "card-status " + (ok ? "ok" : "bad");
  const out = body.querySelector(".card-out") as HTMLElement;
  out.textContent = "";
  out.classList.toggle("err", o.failed);
  printed.forEach((line, i) => {
    const div = document.createElement("div");
    div.className = "ln";
    div.textContent = line === "" ? "​" : line;
    div.style.animationDelay = `${Math.min(i, STAGGERED_LINES) * 45 + (fresh ? 180 : 0)}ms`;
    out.appendChild(div);
  });
  if (printed.length === 0 || (printed.length === 1 && printed[0] === "")) {
    out.innerHTML = `<div class="ln quiet">(nothing printed)</div>`;
  }
  raise(c);

  if (fresh) {
    // Centered, fanned out a little from the cards already open.
    const fan = ((cards.size - 1) % 5) * 28;
    place(c, (innerWidth - c.pos.offsetWidth) / 2 + fan, (innerHeight - c.pos.offsetHeight) / 2 + fan);
  } else {
    if (c.dock) {
      const [x, y] = docked(c, c.dock);
      place(c, x, y, 250);
    }
    stopAnimations(c);
    void body.offsetWidth;
    body.classList.add("bump");
  }
}

/// Close the card for `key`, or the frontmost card.
export function dismissOutput(key?: string): void {
  let entry: [string, Card] | undefined;
  if (key !== undefined) {
    const c = cards.get(key);
    if (c) entry = [key, c];
  } else {
    for (const e of cards) if (!entry || Number(e[1].pos.style.zIndex) > Number(entry[1].pos.style.zIndex)) entry = e;
  }
  if (!entry) return;
  const [k, c] = entry;
  cards.delete(k);
  if (reducedMotion()) { c.pos.remove(); return; }
  stopAnimations(c);
  c.body.style.transition = "transform .22s ease-in, opacity .22s ease-in";
  c.body.style.transform = "translateY(36px) scale(.94)";
  c.body.style.opacity = "0";
  setTimeout(() => c.pos.remove(), 230);
}

function create(key: string): Card {
  const pos = document.createElement("div");
  pos.className = "card-pos";
  pos.innerHTML = `
    <div class="card" role="dialog" aria-label="Program output">
      <div class="card-head">
        <span class="card-title"></span>
        <span class="card-status"></span>
        <button class="card-x" title="Close (Esc)" aria-label="Close">&times;</button>
      </div>
      <pre class="card-out" aria-live="polite"></pre>
      <div class="card-foot">drag to an edge to dock, further to dismiss</div>
    </div>`;
  document.body.appendChild(pos);
  const c: Card = { pos, body: pos.querySelector(".card") as HTMLElement, x: 0, y: 0, dock: null };
  (c.body.querySelector(".card-x") as HTMLButtonElement).onclick = () => dismissOutput(key);
  draggable(key, c);
  return c;
}

function draggable(key: string, c: Card): void {
  let grab: { px: number; py: number; x: number; y: number } | null = null;
  let samples: { x: number; y: number; t: number }[] = [];
  let zone: { edge: Edge; out: boolean } | null = null;
  /// The edge the card is stuck to mid-drag, so a slide only plays on arrival.
  let stuck: Edge | null = null;

  c.body.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || (e.target as Element).closest(".card-x")) return;
    grab = { px: e.clientX, py: e.clientY, x: c.x, y: c.y };
    samples = [{ x: e.clientX, y: e.clientY, t: e.timeStamp }];
    c.body.setPointerCapture(e.pointerId);
    stopAnimations(c);
    raise(c);
    c.body.classList.add("dragging");
    c.pos.style.transition = "none";
    c.body.style.transition = "transform .12s, opacity .12s";
  });

  c.body.addEventListener("pointermove", (e) => {
    if (!grab) return;
    const x = grab.x + e.clientX - grab.px, y = grab.y + e.clientY - grab.py;
    samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
    while (samples.length > 2 && e.timeStamp - samples[0].t > 100) samples.shift();
    const first = samples[0];
    const vx = (e.clientX - first.x) / Math.max(1, e.timeStamp - first.t);
    c.body.style.transform = `rotate(${Math.max(-6, Math.min(6, vx * 6))}deg)`;

    const near = nearest(c, x, y);
    const out = near.gap < -PUSH_OUT * near.size;
    zone = out || near.gap < SNAP ? { edge: near.edge, out } : null;
    const stick = zone && !out ? zone.edge : null;
    if (stick) {
      const [sx, sy] = docked(c, stick, x, y);
      place(c, sx, sy, stick === stuck ? 0 : 140, "ease-out");
    } else {
      place(c, x, y, stuck ? 120 : 0, "ease-out");
    }
    stuck = stick;
    c.body.style.opacity = out ? "0.55" : "";
    hint(zone);
  });

  const release = (e: PointerEvent) => {
    if (!grab) return;
    grab = null;
    c.body.classList.remove("dragging");
    c.body.style.transform = "";
    c.body.style.opacity = "";
    hint(null);
    const first = samples[0], last = samples[samples.length - 1];
    const dt = Math.max(1, last.t - first.t);
    const vx = (last.x - first.x) / dt, vy = (last.y - first.y) / dt;
    const speed = Math.hypot(vx, vy);
    const z = zone;
    zone = null;
    stuck = null;
    if (z?.out || (speed > FLICK_SPEED && e.type === "pointerup")) {
      const normal: Record<Edge, [number, number]> = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
      const [nx, ny] = speed > FLICK_SPEED ? [vx / speed, vy / speed] : normal[(z as { edge: Edge }).edge];
      cards.delete(key);
      throwAway(c, nx, ny, speed);
    } else if (z) {
      c.dock = z.edge;
      const [x, y] = docked(c, z.edge);
      place(c, x, y, 320);
    } else {
      c.dock = null;
      const x = Math.min(Math.max(c.x, MARGIN), innerWidth - c.pos.offsetWidth - MARGIN);
      const y = Math.min(Math.max(c.y, MARGIN), innerHeight - c.pos.offsetHeight - MARGIN);
      if (x !== c.x || y !== c.y) place(c, x, y, 250);
    }
  };
  c.body.addEventListener("pointerup", release);
  c.body.addEventListener("pointercancel", release);
}

/// Send the card off-screen along (nx, ny), faster the harder it was thrown.
function throwAway(c: Card, nx: number, ny: number, speed: number): void {
  const far = Math.max(innerWidth, innerHeight) * 1.2;
  const ms = reducedMotion() ? 0 : Math.max(220, 480 - speed * 100);
  place(c, c.x + nx * far, c.y + ny * far, ms, "cubic-bezier(.3, .6, .5, 1)");
  c.body.style.transition = `transform ${ms}ms, opacity ${ms}ms ease-in`;
  c.body.style.transform = `rotate(${nx * 18 + ny * 6}deg)`;
  c.body.style.opacity = "0";
  setTimeout(() => c.pos.remove(), ms + 20);
}

/// The glow on the edge a dragged card would dock to (red: it would be thrown).
function hint(zone: { edge: Edge; out: boolean } | null): void {
  let el = document.querySelector(".edge-hint") as HTMLElement | null;
  if (!el) {
    el = document.createElement("div");
    document.body.appendChild(el);
  }
  el.className = "edge-hint" + (zone ? ` on ${zone.edge}` + (zone.out ? " out" : "") : "");
}

if (typeof document !== "undefined") {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && cards.size > 0 && !document.querySelector(".float")) dismissOutput();
  });
  addEventListener("resize", () => {
    for (const c of cards.values()) {
      if (c.dock) {
        const [x, y] = docked(c, c.dock);
        place(c, x, y);
      } else {
        place(c, Math.min(c.x, innerWidth - c.pos.offsetWidth - MARGIN), Math.min(c.y, innerHeight - c.pos.offsetHeight - MARGIN));
      }
    }
  });
}
