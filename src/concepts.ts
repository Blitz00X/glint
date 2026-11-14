import type { OverlayLayout } from "./protocol.js";

/**
 * The overlay concepts shown in the picker (`glint pick`). Concepts with a
 * `layout` are real overlay layouts; the rest are designs that are not built
 * yet and cannot be selected.
 */
export interface Concept {
  /** Concept number and slug, e.g. "04-bottom-ticker". */
  id: string;
  name: string;
  /** Short Turkish label from the concept sheet. */
  tr: string;
  description: string;
  /** The overlay layout this concept maps to, or null when it is not built yet. */
  layout: OverlayLayout | null;
  /** Thumbnail path relative to overlay/. */
  thumb: string;
}

export const CONCEPTS: readonly Concept[] = [
  {
    id: "01-top-right-stack",
    name: "Top-right stack",
    tr: "Sağ üst kart yığını",
    description: "Calls stack in the top-right corner; the newest rings, the rest wait on hold. The classic Glint (deneme1).",
    layout: "deneme1",
    thumb: "concepts/01-top-right-stack.png",
  },
  {
    id: "02-giant-hud",
    name: "Giant HUD",
    tr: "Dev hologram ekranı",
    description: "A huge translucent HUD covering 80% of the screen. Impossible to miss (deneme2).",
    layout: "deneme2",
    thumb: "concepts/02-giant-hud.png",
  },
  {
    id: "03-bang-badge",
    name: "Bang badge",
    tr: "Ünlem rozeti",
    description: "A pulsing neon ! in the top-left. Click it (or press the focus hotkey) to open the call (deneme3).",
    layout: "deneme3",
    thumb: "concepts/03-bang-badge.png",
  },
  {
    id: "04-bottom-ticker",
    name: "Bottom ticker",
    tr: "Alt komut şeridi",
    description: "A full-width command strip along the bottom edge, choices inline. Stays out of your code.",
    layout: "ticker",
    thumb: "concepts/04-bottom-ticker.png",
  },
  {
    id: "05-cursor-bubble",
    name: "Cursor bubble",
    tr: "İmleç hologram balonu",
    description: "The call pops up right next to your mouse pointer, wherever you are working.",
    layout: "bubble",
    thumb: "concepts/05-cursor-bubble.png",
  },
  {
    id: "06-edge-strip",
    name: "Edge strip",
    tr: "Kenar ışık şeridi",
    description: "A tall glowing column on the right edge of the screen, from the top bar to the bottom.",
    layout: "edge",
    thumb: "concepts/06-edge-strip.png",
  },
  {
    id: "07-radial-picker",
    name: "Radial picker",
    tr: "Merkez seçim çarkı",
    description: "Choices arranged on a ring around the question in the middle of the screen.",
    layout: null,
    thumb: "concepts/07-radial-picker.png",
  },
  {
    id: "08-island-pill",
    name: "Island pill",
    tr: "Dinamik ada hapı",
    description: "A compact rounded pill at the top center that grows into the call, like a dynamic island.",
    layout: "island",
    thumb: "concepts/08-island-pill.png",
  },
  {
    id: "09-mission-control",
    name: "Mission control",
    tr: "Görev kontrol rayı",
    description: "A docked control rail listing every agent, its calls and the feed side by side.",
    layout: null,
    thumb: "concepts/09-mission-control.png",
  },
];

export function conceptForLayout(layout: OverlayLayout): Concept | undefined {
  return CONCEPTS.find((concept) => concept.layout === layout);
}
