import { GlintError } from "./protocol.js";

export interface CliArgs {
  command: string;
  positionals: string[];
  flags: Set<string>;
  options: Map<string, string>;
  repeated: Map<string, string[]>;
}

const FLAGS = new Set(["http", "no-sandbox", "help", "version", "write", "approvals", "json"]);
const OPTIONS = new Set(["agent", "project", "timeout", "port", "layout", "session", "target", "since"]);
const REPEATED = new Set(["choice"]);

export function parseArgs(argv: string[]): CliArgs {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const options = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  let command = argv[0] ?? "help";

  if (command === "--help" || command === "-h") command = "help";
  if (command === "--version" || command === "-v") command = "version";

  for (let i = command === argv[0] ? 1 : 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (!name) throw new GlintError(`Unknown option ${arg}`);

    if (FLAGS.has(name) && inline === undefined) {
      flags.add(name);
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith("--")) {
      throw new GlintError(`Missing value for --${name}`);
    }
    if (REPEATED.has(name)) {
      const list = repeated.get(name) ?? [];
      list.push(value);
      repeated.set(name, list);
      continue;
    }
    if (OPTIONS.has(name)) {
      options.set(name, value);
      continue;
    }
    throw new GlintError(`Unknown option --${name}`);
  }

  return { command, positionals, flags, options, repeated };
}
