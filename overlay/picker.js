const api = window.glintPicker;
const grid = document.getElementById("grid");
const currentEl = document.getElementById("current");
const hotkeyEl = document.getElementById("hotkey");
const statusEl = document.getElementById("status");
const envNote = document.getElementById("env-note");
let state = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function say(text, tone = "") {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

function nameOf(layout) {
  const concept = state?.concepts.find((item) => item.layout === layout);
  return concept ? `${concept.id.slice(0, 2)} · ${concept.name}` : layout;
}

function render() {
  if (!state) return;
  currentEl.textContent = nameOf(state.current);
  hotkeyEl.textContent = state.hotkey;
  if (state.envLayout) {
    envNote.hidden = false;
    envNote.textContent = `GLINT_LAYOUT=${state.envLayout} is set for the daemon. Your pick applies right away and is saved, but the next daemon start uses GLINT_LAYOUT again until you unset it.`;
  }
  grid.replaceChildren();
  for (const concept of state.concepts) {
    const ready = concept.layout != null;
    const active = ready && concept.layout === state.current;
    const card = el("article", `card${ready ? "" : " soon"}${active ? " active" : ""}`);
    card.dataset.concept = concept.id;
    const shot = el("div", "shot");
    const img = el("img");
    img.src = concept.thumb;
    img.alt = `${concept.name} concept`;
    img.loading = "lazy";
    shot.append(img);
    if (!ready) shot.append(el("div", "soon-mark", "YAKINDA · COMING SOON"));
    if (active) shot.append(el("div", "active-mark", "● ACTIVE"));
    const head = el("div", "card-head");
    head.append(el("span", "num", concept.id.slice(0, 2)), el("span", "name", concept.name.toUpperCase()));
    if (concept.layout && concept.layout.startsWith("deneme")) head.append(el("span", "alias", concept.layout));
    const tr = el("div", "tr", concept.tr);
    const desc = el("p", "desc", concept.description);
    const actions = el("div", "actions");
    const preview = el("button", "btn ghost", "Preview");
    preview.type = "button";
    const use = el("button", "btn", active ? "In use" : "Use this");
    use.type = "button";
    if (!ready) {
      preview.disabled = true;
      use.disabled = true;
      use.textContent = "Coming soon";
    } else {
      preview.addEventListener("click", () => void doPreview(concept));
      use.disabled = active;
      use.addEventListener("click", () => void doUse(concept));
    }
    actions.append(preview, use);
    card.append(shot, head, tr, desc, actions);
    grid.append(card);
  }
}

async function doPreview(concept) {
  say(`Ringing a sample call in ${concept.name}… answer it or press esc on the panel.`);
  const res = await api.preview(concept.layout);
  if (res?.ok) say(`Sample call is up in ${concept.name}. It hangs up by itself in 45s.`, "ok");
  else say(`Preview failed: ${res?.error ?? "unknown error"}`, "bad");
}

async function doUse(concept) {
  const res = await api.use(concept.layout);
  if (!res?.ok) {
    say(`Could not switch: ${res?.error ?? "unknown error"}`, "bad");
    return;
  }
  state.current = res.layout;
  render();
  say(`${concept.name} is now the Glint style. Saved to ~/.glint/config.json.`, "ok");
}

document.getElementById("close").addEventListener("click", () => api.close());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") api.close();
});

if (!api) {
  document.body.textContent = "Open the picker with `glint pick`.";
} else {
  api.onLayout((layout) => {
    if (!state) return;
    state.current = layout;
    render();
  });
  void api.state().then((next) => {
    state = next;
    render();
  });
}
