const stack = document.getElementById("stack");
const badge = document.getElementById("badge");
const badgeCount = document.getElementById("badge-count");
const feed = document.getElementById("feed");
const feedList = document.getElementById("feed-list");
const feedMeta = document.getElementById("feed-meta");
const api = window.glint;
const sound = window.glintSound;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const INCOMING_MS = reducedMotion ? 0 : 1100;
const ENDED_MS = reducedMotion ? 0 : 1400;
const MAX_FEED = 100;

let hotkeyLabel = "ctrl+shift+g";
let feedHotkeyLabel = "ctrl+shift+f";
let jumpHotkeyLabel = "ctrl+shift+j";
let daemonLayout = "deneme1";
let badgeExpanded = false;
let feedOpen = false;
let feedUnread = 0;
const deferredActivations = new Map();
/** Calls in arrival order: id -> { question, panel, start } */
const calls = new Map();
let activeId = null;
const feedEvents = [];
const feedSeen = new Set();

const LAYOUTS = ["deneme1", "deneme2", "deneme3", "ticker", "bubble", "edge", "island"];

function isValidLayout(value) {
  return LAYOUTS.includes(value);
}

if (!api) {
  document.body.textContent = "Glint's overlay is drawn by the daemon.";
} else {
  api.onConfig((config) => {
    if (!config) return;
    if (typeof config.hotkeyLabel === "string") {
      hotkeyLabel = config.hotkeyLabel;
      for (const node of document.querySelectorAll("[data-hotkey]")) node.textContent = hotkeyLabel;
    }
    if (typeof config.jumpHotkeyLabel === "string") jumpHotkeyLabel = config.jumpHotkeyLabel;
    if (typeof config.feedHotkeyLabel === "string") {
      feedHotkeyLabel = config.feedHotkeyLabel;
      for (const node of document.querySelectorAll("[data-feed-hotkey]")) node.textContent = feedHotkeyLabel;
    }
    sound?.setMuted(config.mute === true);
    if (isValidLayout(config.layout)) {
      daemonLayout = config.layout;
      syncLayout();
    }
    if (config.openFeed) setFeedOpen(true);
  });
  api.onLayout?.((layout) => {
    if (!isValidLayout(layout)) return;
    daemonLayout = layout;
    badgeExpanded = false;
    for (const panel of stack.querySelectorAll(".panel")) {
      if (panel.dataset.explicitLayout !== "1") panel.dataset.layout = layout;
    }
    const { collapsed } = syncLayout();
    if (!collapsed) flushDeferred();
    reportSize();
  });
  api.onQuestion(addQuestion);
  api.onNotice(addNotice);
  api.onResolved(onResolved);
  api.onFocusLatest(focusLatest);
  api.onHistory?.(loadHistory);
  api.onEvent?.(addFeedEvent);
  api.onToggleFeed?.(() => setFeedOpen(!feedOpen));
  api.onJumpActive?.(jumpActive);
  api.ready();
}

badge?.addEventListener("click", (event) => {
  event.stopPropagation();
  expandBadge(true);
});

/* ------------------------------------------------------------------ calls */

function initials(name) {
  const words = String(name || "agent")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] || "AG").slice(0, 2).toUpperCase();
}

function callerOf(item) {
  const c = item && item.caller ? item.caller : {};
  return {
    name: c.name || item?.agent || "agent",
    project: c.project ?? item?.project ?? "",
    tag: c.tag || "",
    color: c.color || "#5dfff0",
    origin: c.origin && typeof c.origin === "object" ? c.origin : null,
  };
}

/* ------------------------------------------------------- origin + jump */

function baseName(dir) {
  const parts = String(dir || "").split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(dir || "");
}

function originText(origin) {
  if (!origin) return "";
  const parts = [];
  if (origin.cwd) parts.push(`${origin.project || baseName(origin.cwd)}${origin.branch ? ` ⎇ ${origin.branch}` : ""}`);
  if (origin.app) parts.push(origin.tmux && origin.tmux.target ? `${origin.app} ${origin.tmux.target}` : origin.app);
  if (origin.tty && origin.kind !== "desktop") parts.push(origin.tty);
  return parts.join("  ·  ");
}

function jumpLabel(origin) {
  if (!origin) return "↗ go to source";
  if (origin.kind === "desktop" || origin.kind === "vscode") return `↗ go to ${origin.app || "app"}`;
  return "↗ go to terminal";
}

function canJump(origin) {
  return !!(origin && (origin.gnomeScreen || origin.windowId || origin.pid || origin.tmux || origin.cwd));
}

async function jump(origin, statusEl) {
  if (!origin || !api.jump) return;
  if (statusEl) statusEl.textContent = "jumping…";
  let result;
  try {
    result = await api.jump(origin);
  } catch (error) {
    result = { ok: false, message: String(error && error.message ? error.message : error) };
  }
  if (statusEl) {
    statusEl.textContent = result && result.message ? (result.ok ? `✓ ${result.message}` : result.message) : "";
    statusEl.classList.toggle("fail", !(result && result.ok));
    window.setTimeout(() => {
      if (statusEl.isConnected) statusEl.textContent = "";
    }, result && result.ok ? 2500 : 9000);
  }
}

/** Folder ⎇ branch · app · tty, the last prompt, and the jump button. */
function originBlock(origin) {
  if (!origin) return null;
  const box = document.createElement("div");
  box.className = "origin";
  const line = document.createElement("div");
  line.className = "origin-line";
  const text = document.createElement("span");
  text.className = "origin-where";
  text.textContent = originText(origin);
  text.title = [origin.cwd, origin.tty].filter(Boolean).join("  ");
  line.append(text);
  const status = document.createElement("span");
  status.className = "jump-status";
  if (canJump(origin)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "jump";
    button.textContent = jumpLabel(origin);
    button.title = `${jumpLabel(origin)} (${jumpHotkeyLabel})`;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void jump(origin, status);
    });
    line.append(button);
  }
  box.append(line);
  if (origin.title) {
    const title = document.createElement("div");
    title.className = "origin-title";
    title.textContent = `“${origin.title}”`;
    box.append(title);
  }
  box.append(status);
  return box;
}

const KIND_LABEL = {
  question: "QUESTION",
  stop: "STOPPED · WAITING FOR YOU",
  approval: "NEEDS APPROVAL",
};

function callerCard(item, kind) {
  const caller = callerOf(item);
  const card = document.createElement("div");
  card.className = "caller";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = initials(caller.name);
  const ring = document.createElement("span");
  ring.className = "ring";
  avatar.append(ring);

  const who = document.createElement("div");
  who.className = "who";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = caller.name;
  if (caller.tag) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = `#${caller.tag}`;
    name.append(tag);
  }
  const where = document.createElement("div");
  where.className = "where";
  where.textContent = [caller.project, KIND_LABEL[kind] || KIND_LABEL.question].filter(Boolean).join("  ·  ");
  who.append(name, where);

  const status = document.createElement("div");
  status.className = "status";
  status.textContent = "INCOMING";
  card.append(avatar, who, status);
  return { card, status };
}

function addQuestion(question) {
  if (!question || calls.has(question.id)) return;
  const caller = callerOf(question);
  const panel = document.createElement("article");
  panel.className = "panel call on-hold";
  panel.id = panelId(question.id);
  panel.dataset.layout = question.layout || daemonLayout;
  panel.dataset.explicitLayout = question.layout ? "1" : "";
  panel.style.setProperty("--accent", caller.color);
  panel.tabIndex = 0;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", labelFor(caller.name, caller.project));

  const { card, status } = callerCard(question, question.kind);
  panel.append(sweep(), ...corners(), card);
  const origin = originBlock(caller.origin);
  if (origin) panel.append(origin);

  const body = document.createElement("div");
  body.className = "call-body";

  const typed = document.createElement("span");
  typed.className = "typed";
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.setAttribute("aria-hidden", "true");
  const questionEl = document.createElement("p");
  questionEl.className = "question";
  questionEl.append(typed, caret);
  body.append(questionEl);

  const choices = Array.isArray(question.choices) ? question.choices.slice(0, 9) : [];
  let selected = choices.length > 0 ? 0 : -1;
  const choiceButtons = [];
  if (choices.length > 0) {
    const list = document.createElement("div");
    list.className = "choices";
    choices.forEach((choice, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "choice";
      if (index === selected) button.classList.add("selected");
      const key = document.createElement("kbd");
      key.textContent = String(index + 1);
      const text = document.createElement("span");
      text.textContent = choice;
      button.append(key, text);
      button.addEventListener("click", () => choose(index));
      button.addEventListener("mouseenter", () => setSelected(index));
      list.append(button);
      choiceButtons.push(button);
    });
    body.append(list);
  }

  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 4000;
  input.spellcheck = false;
  input.autocomplete = "off";
  input.placeholder = choices.length > 0 ? "or type an answer" : "type an answer";
  input.setAttribute("aria-label", "Free text answer");
  const form = document.createElement("form");
  form.className = "composer";
  const prompt = document.createElement("span");
  prompt.className = "prompt";
  prompt.textContent = ">";
  form.append(prompt, input);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitText();
  });
  body.append(form);

  const hint = document.createElement("footer");
  const keys = choices.length > 0 ? "1-9 answer  ·  " : "";
  hint.append(keys, "enter sends  ·  esc hangs up  ·  ");
  const hotkey = document.createElement("span");
  hotkey.dataset.hotkey = "1";
  hotkey.textContent = hotkeyLabel;
  const feedKey = document.createElement("span");
  feedKey.dataset.feedHotkey = "1";
  feedKey.textContent = feedHotkeyLabel;
  hint.append(hotkey, " focus  ·  ", feedKey, " feed");
  if (caller.origin && canJump(caller.origin)) hint.append(`  ·  ${jumpHotkeyLabel} jump`);
  const hold = document.createElement("span");
  hold.className = "hold-count";
  hint.append(hold);
  body.append(hint);

  if (typeof question.timeoutMs === "number") {
    const timeout = document.createElement("div");
    timeout.className = "timeout";
    const deadline = (question.createdAt || Date.now()) + question.timeoutMs;
    const tick = (first) => {
      const left = Math.max(0, deadline - Date.now());
      timeout.textContent = `line closes in ${formatDuration(left)}`;
      if (left > 0 && (first || panel.isConnected)) window.setTimeout(() => tick(false), 500);
    };
    tick(true);
    body.append(timeout);
  }
  panel.append(body);

  const holdLine = document.createElement("button");
  holdLine.type = "button";
  holdLine.className = "hold-line";
  holdLine.textContent = "ON HOLD · click to switch";
  holdLine.addEventListener("click", (event) => {
    event.stopPropagation();
    switchTo(question.id);
  });
  panel.append(holdLine);

  let sent = false;
  function choose(index) {
    if (!choices[index]) return;
    send({ id: question.id, status: "answered", choiceIndex: index, via: "choice" });
  }
  function submitText() {
    const answer = input.value.trim();
    if (answer) {
      send({ id: question.id, status: "answered", answer, via: "text" });
      return;
    }
    if (selected >= 0) choose(selected);
  }
  function dismiss() {
    send({ id: question.id, status: "dismissed", via: "dismiss" });
  }
  function send(payload) {
    if (sent) return;
    sent = true;
    panel.classList.add("sending");
    if (payload.status === "answered") sound?.answered();
    void api.answer(payload).then((result) => {
      if (result && result.ok === false) {
        sent = false;
        panel.classList.remove("sending");
      }
    });
  }
  function setSelected(index) {
    selected = index;
    choiceButtons.forEach((button, buttonIndex) => {
      button.classList.toggle("selected", buttonIndex === index);
    });
  }

  panel.addEventListener("mousedown", () => api.focusWindow());
  panel.addEventListener("keydown", (event) => {
    if (panel.classList.contains("on-hold") || panel.classList.contains("ending")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      dismiss();
      return;
    }
    const typing = document.activeElement === input && input.value.length > 0;
    if (/^[1-9]$/.test(event.key) && !typing) {
      const index = Number(event.key) - 1;
      if (choices[index]) {
        event.preventDefault();
        choose(index);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (choices.length === 0) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = selected < 0 ? 0 : (selected + delta + choices.length) % choices.length;
      setSelected(next);
      choiceButtons[next]?.focus();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      submitText();
    }
  });

  let typingStarted = false;
  const startTyping = () => {
    if (typingStarted) return;
    typingStarted = true;
    const stop = typewrite(typed, String(question.question ?? ""), () => caret.remove());
    panel.addEventListener("glint-remove", stop, { once: true });
  };

  const timer = window.setInterval(() => {
    if (!panel.isConnected) return window.clearInterval(timer);
    if (panel.classList.contains("connected")) {
      status.textContent = `LIVE ${formatClock(Date.now() - (question.createdAt || Date.now()))}`;
    } else if (panel.classList.contains("on-hold")) {
      status.textContent = "ON HOLD";
    }
  }, 500);

  calls.set(question.id, { question, panel, startTyping, status });
  stack.append(panel);
  if (!activeId) {
    activate(question.id, true);
  } else {
    // Call waiting: a soft tick, the call shows as a one-line hold strip.
    sound?.notice();
    updateHoldCounts();
  }
  syncLayout();
  reportSize();
}

function activate(id, ring) {
  const call = calls.get(id);
  if (!call) return;
  activeId = id;
  const { panel, startTyping, status } = call;
  panel.classList.remove("on-hold", "connected");
  panel.classList.add("active");
  stack.prepend(panel);
  updateHoldCounts();
  const { collapsed } = syncLayout();
  const goLive = () => {
    if (!panel.isConnected || activeId !== id) return;
    panel.classList.remove("incoming");
    panel.classList.add("connected");
    startTyping();
    reportSize();
  };
  if (ring) {
    panel.classList.add("incoming");
    status.textContent = "INCOMING CALL";
    sound?.incoming();
    const begin = () => window.setTimeout(goLive, INCOMING_MS);
    if (collapsed) deferredActivations.set(id, begin);
    else begin();
  } else {
    goLive();
  }
  reportSize();
}

function switchTo(id) {
  if (!calls.has(id) || id === activeId) return;
  const current = activeId ? calls.get(activeId) : null;
  if (current) {
    current.panel.classList.remove("active", "connected", "incoming");
    current.panel.classList.add("on-hold");
    stack.append(current.panel);
  }
  activate(id, false);
  api.focusWindow();
  window.setTimeout(() => focusPanel(calls.get(id)?.panel), 40);
}

function nextWaitingId() {
  for (const [id, call] of calls) {
    if (id !== activeId && !call.panel.classList.contains("ending")) return id;
  }
  return null;
}

function updateHoldCounts() {
  const holding = [...calls.values()].filter((call) => call.panel.classList.contains("on-hold")).length;
  for (const node of stack.querySelectorAll(".hold-count")) {
    node.textContent = holding > 0 ? `  ·  +${holding} on hold` : "";
  }
}

const ENDED_TEXT = {
  answered: "answer sent",
  dismissed: "hung up",
  timeout: "no answer · line timed out",
  disconnect: "caller hung up",
};

function onResolved(payload) {
  const id = typeof payload === "string" ? payload : payload?.id;
  const result = typeof payload === "object" && payload ? payload.result : null;
  if (!id) return;
  if (!calls.has(id)) {
    removePanel(id);
    return;
  }
  endCall(id, result);
}

function endCall(id, result) {
  const call = calls.get(id);
  if (!call) return;
  const { panel } = call;
  deferredActivations.delete(id);
  const wasActive = id === activeId;
  const why = result?.via === "disconnect" ? "disconnect" : result?.status || "answered";
  if (!wasActive || panel.classList.contains("on-hold")) {
    calls.delete(id);
    removePanel(id);
    updateHoldCounts();
    return;
  }
  panel.dispatchEvent(new Event("glint-remove"));
  panel.classList.remove("incoming", "connected");
  panel.classList.add("ending");
  const banner = document.createElement("div");
  banner.className = "ended-banner";
  const big = document.createElement("strong");
  big.textContent = "CALL ENDED";
  const small = document.createElement("span");
  small.textContent = ENDED_TEXT[why] || "";
  banner.append(big, small);
  panel.append(banner);
  sound?.ended();
  window.setTimeout(() => {
    calls.delete(id);
    panel.remove();
    if (activeId === id) activeId = null;
    const next = nextWaitingId();
    if (next) activate(next, true);
    syncLayout();
    reportSize();
  }, ENDED_MS);
}

/* ---------------------------------------------------------------- notices */

function addNotice(notice) {
  if (!notice || document.getElementById(panelId(notice.id))) return;
  const caller = callerOf(notice);
  const panel = document.createElement("article");
  panel.className = "panel notice";
  panel.id = panelId(notice.id);
  panel.dataset.layout = notice.layout || daemonLayout;
  panel.dataset.explicitLayout = notice.layout ? "1" : "";
  panel.style.setProperty("--accent", caller.color);
  panel.tabIndex = 0;
  panel.setAttribute("role", "status");

  const copy = document.createElement("p");
  copy.className = "notice-copy";
  const typed = document.createElement("span");
  typed.className = "typed";
  const caret = document.createElement("span");
  caret.className = "caret";
  copy.append(typed, caret);

  const meter = document.createElement("div");
  meter.className = "meter";
  const bar = document.createElement("span");
  const duration = typeof notice.durationMs === "number" ? notice.durationMs : 6500;
  bar.style.animationDuration = `${duration}ms`;
  meter.append(bar);

  const hint = document.createElement("div");
  hint.className = "notice-hint";
  const hintLeft = document.createElement("span");
  hintLeft.textContent = "click or esc to dismiss";
  const hintRight = document.createElement("span");
  hintRight.textContent = "kept in the feed · ";
  const feedKey = document.createElement("span");
  feedKey.dataset.feedHotkey = "1";
  feedKey.textContent = feedHotkeyLabel;
  hintRight.append(feedKey);
  hint.append(hintLeft, hintRight);

  panel.append(sweep(), ...corners(), header(caller, true));
  const origin = originBlock(caller.origin);
  if (origin) panel.append(origin);
  panel.append(copy, hint, meter);
  panel.addEventListener("mousedown", () => api.focusWindow());
  panel.addEventListener("click", () => removePanel(notice.id));
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape" || event.key === "Enter") {
      event.preventDefault();
      removePanel(notice.id);
    }
  });

  stack.append(panel);
  sound?.notice();
  const { collapsed } = syncLayout();
  const startNotice = () => {
    bar.style.animationPlayState = "running";
    const stop = typewrite(typed, String(notice.message ?? ""), () => caret.remove());
    const timer = window.setTimeout(() => removePanel(notice.id), duration);
    panel.addEventListener(
      "glint-remove",
      () => {
        stop();
        window.clearTimeout(timer);
      },
      { once: true },
    );
  };
  if (collapsed) {
    bar.style.animationPlayState = "paused";
    deferredActivations.set(notice.id, startNotice);
  } else {
    startNotice();
  }
  reportSize();
}

function header(caller, notice) {
  const row = document.createElement("header");
  const brand = document.createElement("span");
  brand.className = notice ? "brand notice-brand" : "brand";
  brand.textContent = notice ? "MSG" : "GLINT";
  const source = document.createElement("span");
  source.className = "source";
  source.textContent = labelFor(caller.name, caller.project) + (caller.tag ? `  #${caller.tag}` : "");
  const live = document.createElement("span");
  live.className = "live";
  const dot = document.createElement("i");
  live.append(dot, document.createTextNode(notice ? "PUSH" : "LIVE"));
  row.append(brand, source, live);
  return row;
}

function labelFor(agent, project) {
  const who = (agent || "agent").trim();
  const where = (project || "").trim();
  return where ? `${who}  ·  ${where}` : who;
}

function sweep() {
  const node = document.createElement("div");
  node.className = "sweep";
  return node;
}

function corners() {
  return ["tl", "tr", "bl", "br"].map((name) => {
    const node = document.createElement("span");
    node.className = `corner ${name}`;
    return node;
  });
}

function removePanel(id) {
  deferredActivations.delete(id);
  const panel = document.getElementById(panelId(id));
  if (!panel || panel.classList.contains("leaving")) return;
  panel.dispatchEvent(new Event("glint-remove"));
  panel.classList.add("leaving");
  window.setTimeout(() => {
    panel.remove();
    syncLayout();
    reportSize();
  }, reducedMotion ? 0 : 150);
}

function activePanel() {
  if (activeId && calls.has(activeId)) return calls.get(activeId).panel;
  return stack.querySelector(".panel.notice:not(.leaving)");
}

/** Ctrl+Shift+J: jump to where the active call (or the newest call in the feed) came from. */
function jumpActive() {
  let entry = activeId && calls.has(activeId) ? calls.get(activeId) : null;
  let origin = entry ? callerOf(entry.question).origin : null;
  let statusEl = entry ? entry.panel.querySelector(".jump-status") : null;
  if (!origin) {
    for (let i = feedEvents.length - 1; i >= 0; i--) {
      const o = callerOf(feedEvents[i]).origin;
      if (o) {
        origin = o;
        break;
      }
    }
  }
  if (origin) void jump(origin, statusEl);
}

function focusLatest() {
  const panel = activePanel();
  if (!panel) {
    // A notice is gone after a few seconds and a call may already be answered.
    // The shortcut should still do something visible instead of dying silently:
    // open the feed, which keeps the recent calls and answers.
    if (feedEvents.length > 0) {
      setFeedOpen(true);
      api.focusWindow();
    }
    return;
  }
  if (document.body.dataset.layout === "deneme3" && !badgeExpanded) {
    expandBadge(false);
  }
  api.focusWindow();
  const apply = () => focusPanel(panel);
  apply();
  window.setTimeout(apply, 40);
}

function focusPanel(panel) {
  if (!panel) return;
  if (panel.classList.contains("notice") || panel.querySelector(".choice")) panel.focus();
  else panel.querySelector("input")?.focus();
}

document.addEventListener("keydown", (event) => {
  if (!(event.target instanceof Element) || event.target.closest(".panel")) return;
  const panel = activePanel();
  if (!panel) {
    if (event.key === "Escape" && feedOpen) setFeedOpen(false);
    return;
  }
  event.preventDefault();
  focusPanel(panel);
  panel.dispatchEvent(new KeyboardEvent("keydown", { key: event.key, bubbles: true, cancelable: true }));
});

function typewrite(node, text, onDone) {
  if (reducedMotion || text.length === 0) {
    node.textContent = text;
    onDone();
    return () => {};
  }
  const total = Math.min(1100, Math.max(220, text.length * 16));
  const start = performance.now();
  let frame = 0;
  let stopped = false;
  const tick = (now) => {
    if (stopped) return;
    const progress = Math.min(1, (now - start) / total);
    const count = Math.max(1, Math.ceil(text.length * progress));
    node.textContent = text.slice(0, count);
    if (progress < 1) frame = requestAnimationFrame(tick);
    else onDone();
  };
  frame = requestAnimationFrame(tick);
  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
    node.textContent = text;
  };
}

/* ------------------------------------------------------------------- feed */

function setFeedOpen(open) {
  feedOpen = Boolean(open);
  feed.hidden = !feedOpen;
  document.body.dataset.feed = feedOpen ? "open" : "";
  if (feedOpen) {
    feedUnread = 0;
    updateFeedMeta();
    requestAnimationFrame(() => {
      feedList.scrollTop = feedList.scrollHeight;
    });
  }
  reportSize();
}

function loadHistory(events) {
  if (!Array.isArray(events)) return;
  feedEvents.length = 0;
  feedSeen.clear();
  feedList.textContent = "";
  for (const event of events) addFeedEvent(event, true);
  updateFeedMeta();
}

function addFeedEvent(event, fromHistory = false) {
  if (!event || feedSeen.has(event.seq)) return;
  feedSeen.add(event.seq);
  feedEvents.push(event);
  feedList.append(renderFeedEvent(event));
  while (feedEvents.length > MAX_FEED) {
    const old = feedEvents.shift();
    feedSeen.delete(old.seq);
    feedList.firstElementChild?.remove();
  }
  if (!fromHistory && !feedOpen) feedUnread++;
  updateFeedMeta();
  if (feedOpen) {
    const nearBottom = feedList.scrollHeight - feedList.scrollTop - feedList.clientHeight < 80;
    if (nearBottom || !fromHistory) feedList.scrollTop = feedList.scrollHeight;
    reportSize();
  }
}

function updateFeedMeta() {
  if (!feedMeta) return;
  const agents = new Set(feedEvents.map((event) => `${event.caller?.name}#${event.caller?.tag}`)).size;
  feedMeta.textContent = `${agents} agent${agents === 1 ? "" : "s"} · ${feedEvents.length}/${MAX_FEED} msgs${feedUnread ? ` · ${feedUnread} new` : ""}`;
}

function renderFeedEvent(event) {
  const caller = callerOf(event);
  const row = document.createElement("div");
  row.className = `msg ${event.type}`;
  row.style.setProperty("--accent", caller.color);
  if (event.type === "answer" && event.status !== "answered") {
    row.className = "msg system";
    row.textContent = `${clock(event.at)}  ☎ call with ${caller.name} #${caller.tag} ended · ${event.text}`;
    return row;
  }
  const meta = document.createElement("div");
  meta.className = "meta";
  const name = document.createElement("span");
  name.className = "who";
  if (event.type === "answer") {
    name.textContent = "you";
    const to = document.createElement("span");
    to.className = "to";
    to.textContent = ` → ${caller.name} #${caller.tag}`;
    meta.append(name, to);
  } else {
    name.textContent = caller.name;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = `#${caller.tag}`;
    const where = document.createElement("span");
    where.className = "where";
    where.textContent = caller.project ? ` · ${caller.project}` : "";
    meta.append(name, tag, where);
    if (caller.origin && canJump(caller.origin)) {
      const go = document.createElement("button");
      go.type = "button";
      go.className = "feed-jump";
      go.textContent = "↗";
      go.title = `${jumpLabel(caller.origin)} · ${originText(caller.origin)}`;
      go.addEventListener("click", (e) => {
        e.stopPropagation();
        void jump(caller.origin, null);
      });
      meta.append(go);
    }
    if (event.type === "call") {
      const kind = document.createElement("span");
      kind.className = "kind";
      kind.textContent = event.kind === "stop" ? "☎ waiting" : event.kind === "approval" ? "☎ approval" : "☎ call";
      meta.append(kind);
    }
  }
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = clock(event.at);
  meta.append(time);

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = event.text;
  row.append(meta, bubble);
  if (event.type === "call" && Array.isArray(event.choices) && event.choices.length) {
    const chips = document.createElement("div");
    chips.className = "chips";
    event.choices.forEach((choice, index) => {
      const chip = document.createElement("span");
      chip.textContent = `${index + 1} ${choice}`;
      chips.append(chip);
    });
    row.append(chips);
  }
  return row;
}

/* ----------------------------------------------------------------- layout */

function flushDeferred() {
  for (const [id, start] of deferredActivations.entries()) {
    deferredActivations.delete(id);
    start();
  }
}

function expandBadge(focus = false) {
  if (badgeExpanded) return;
  badgeExpanded = true;
  syncLayout();
  flushDeferred();
  reportSize();
  if (focus) {
    api.focusWindow();
    const panel = activePanel();
    if (panel) window.setTimeout(() => focusPanel(panel), 40);
  }
}

function syncLayout() {
  const panels = [...stack.querySelectorAll(".panel:not(.leaving)")];
  if (panels.length === 0) badgeExpanded = false;
  const active = panels[0]?.dataset.layout || daemonLayout || "deneme1";
  const collapsed = active === "deneme3" && panels.length > 0 && !badgeExpanded && !feedOpen;
  document.body.dataset.layout = active;
  document.body.dataset.badge = active === "deneme3" ? (collapsed ? "collapsed" : "open") : "";
  if (badgeCount) {
    badgeCount.textContent = String(panels.length);
    badgeCount.hidden = panels.length <= 1;
  }
  return { count: panels.length, layout: active, collapsed };
}

let resizeFrame = 0;
function reportSize() {
  if (!api) return;
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    const { count, layout, collapsed } = syncLayout();
    const empty = count === 0 && !feedOpen;
    const height = empty ? 0 : collapsed ? 84 : Math.ceil(document.body.scrollHeight);
    api.resize(height, layout, collapsed, feedOpen ? "feed" : "calls");
  });
}

function panelId(id) {
  return `panel-${id}`;
}

function clock(at) {
  const d = new Date(at || Date.now());
  return d.toTimeString().slice(0, 5);
}

function formatClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function formatDuration(ms) {
  const s = Math.ceil(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

new ResizeObserver(() => reportSize()).observe(stack);
new ResizeObserver(() => reportSize()).observe(feed);
if (document.fonts && document.fonts.ready) {
  void document.fonts.ready.then(() => reportSize());
}
