import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/args.js";
import {
  formatAskResult,
  GlintError,
  parseAskInput,
  parseLayout,
  parseNotifyInput,
  parseSettleInput,
} from "../src/protocol.js";

test("ask input trims text and keeps choices", () => {
  const parsed = parseAskInput({
    question: "  Ship it?  ",
    choices: [" Yes ", "No"],
    agent: " Codex ",
    timeoutMs: 1500,
  });
  assert.equal(parsed.question, "Ship it?");
  assert.deepEqual(parsed.choices, ["Yes", "No"]);
  assert.equal(parsed.agent, "Codex");
  assert.equal(parsed.timeoutMs, 1500);
});

test("ask input rejects an empty question and a tenth choice", () => {
  assert.throws(() => parseAskInput({ question: "   " }), GlintError);
  assert.throws(
    () => parseAskInput({ question: "Pick", choices: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"] }),
    GlintError,
  );
});

test("notify and settle parsers reject bad payloads", () => {
  assert.equal(parseNotifyInput({ message: " done " }).message, "done");
  assert.throws(() => parseNotifyInput({ message: "" }), GlintError);
  assert.throws(() => parseSettleInput({ id: "", status: "answered" }), GlintError);
  assert.equal(parseSettleInput({ id: "q1", status: "dismissed" }).status, "dismissed");
});

test("formatted results tell the agent what happened", () => {
  const answered = formatAskResult({
    id: "q",
    status: "answered",
    answer: "Apply it now",
    choiceIndex: 0,
    via: "choice",
  });
  assert.match(answered, /choice 1/);
  assert.match(answered, /Apply it now/);
  assert.match(formatAskResult({ id: "q", status: "dismissed", answer: null, choiceIndex: null, via: "dismiss" }), /dismissed/);
  assert.match(formatAskResult({ id: "q", status: "timeout", answer: null, choiceIndex: null, via: "timeout" }), /timed out/);
});

test("cli parser collects repeated choices", () => {
  const args = parseArgs([
    "ask",
    "Ship it?",
    "--choice",
    "Yes",
    "--choice=Not yet",
    "--agent",
    "Codex",
    "--timeout",
    "5000",
    "--no-sandbox",
  ]);
  assert.equal(args.command, "ask");
  assert.deepEqual(args.positionals, ["Ship it?"]);
  assert.deepEqual(args.repeated.get("choice"), ["Yes", "Not yet"]);
  assert.equal(args.options.get("agent"), "Codex");
  assert.equal(args.options.get("timeout"), "5000");
  assert.equal(args.flags.has("no-sandbox"), true);
});

test("cli parser rejects an unknown flag", () => {
  assert.throws(() => parseArgs(["ask", "hi", "--nope"]), GlintError);
});

test("layout parser preserves deneme1 and deneme2 presets", () => {
  assert.equal(parseLayout("deneme1"), "deneme1");
  assert.equal(parseLayout("corner"), "deneme1");
  assert.equal(parseLayout("deneme2"), "deneme2");
  assert.equal(parseLayout("center"), "deneme2");
  assert.equal(parseLayout("deneme3"), "deneme3");
  assert.equal(parseLayout("badge"), "deneme3");
  assert.equal(parseLayout("unknown"), undefined);
  assert.equal(parseNotifyInput({ message: "ok", layout: "deneme2" }).layout, "deneme2");
  assert.equal(parseNotifyInput({ message: "ok", layout: "deneme3" }).layout, "deneme3");
  const args = parseArgs(["notify", "hi", "--layout", "deneme2"]);
  assert.equal(args.options.get("layout"), "deneme2");
});
