// Automa modifications: SIGPIPE-style early stop for `producer | head`.
/**
 * Pipeline stages still run one after another. When the next stage is a
 * consumer that provably reads only a prefix of its stdin (`head -n N`,
 * `head -c N`, `sed -n 'M,Np'`, `sed Nq`), a read-only producer (grep, cat,
 * a registered rg, or literal git grep) receives a `stdoutLimit` and may stop once it has
 * written more than that prefix. The consumer then sees a longer input
 * than it reads, so its output is unchanged; the stopped producer reports 141
 * (128 + SIGPIPE) in PIPESTATUS, as bash does when head closes the pipe.
 *
 * Anything that could observe the difference disables it: pipefail, `|&`,
 * a function or alias named like either command, producer redirections other
 * than stderr, and consumer operands or input redirections. Substitutions in
 * the producer's words still run in full; they run one level deeper, so a
 * command they dispatch never takes the limit.
 */
import type { CommandNode, SimpleCommandNode, WordNode } from "../ast/types.js";
import type { InterpreterContext } from "./types.js";

export interface StdoutLimit {
  /** Lines (newlines) / UTF-16 units the consumer will read. */
  readonly lines?: number;
  readonly bytes?: number;
  /**
   * True once `stdout` (the producer's accumulated output so far, growing
   * between calls) holds more than the consumer reads. Incremental.
   */
  reached(stdout: string): boolean;
  /** The producer stopped early; it reports 141 to PIPESTATUS. */
  stop(): void;
}

export interface PendingStdoutLimit {
  name: string;
  /** Substitutions in the producer's words run one level deeper. */
  depth: number;
  limit: StdoutLimit;
  stopped: boolean;
  taken: boolean;
}

export const SIGPIPE_STATUS = 141;
const PRODUCERS = new Set(["grep", "egrep", "fgrep", "cat", "rg"]);
const MAX_PREFIX = 1_000_000;

/** A word's value when it is fully literal (no expansion of any kind). */
function literal(word: WordNode): string | undefined {
  let out = "";
  for (const part of word.parts) {
    if (part.type === "Literal" || part.type === "SingleQuoted")
      out += part.value;
    else if (part.type === "Escaped") out += part.value;
    else if (
      part.type === "DoubleQuoted" &&
      part.parts.every((p) => p.type === "Literal")
    )
      out += part.parts.map((p) => (p as { value: string }).value).join("");
    else return undefined;
  }
  return out;
}

const count = (value: string | undefined) =>
  value !== undefined && /^[0-9]{1,7}$/.test(value) ? Number(value) : undefined;

type Prefix = { lines?: number; bytes?: number };

const HEAD_FLAGS = new Set([
  "-q",
  "-v",
  "--quiet",
  "--silent",
  "--verbose",
  "-",
]);

/** `head` options: the last count option wins, as in GNU head. */
function headPrefix(args: readonly string[]): Prefix | undefined {
  let prefix: Prefix = { lines: 10 };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (HEAD_FLAGS.has(arg)) continue;
    const separate = /^(?:-n|--lines|-c|--bytes)$/.test(arg);
    const value = separate
      ? args[++i]
      : arg.match(/^(?:-n|--lines=|-c|--bytes=|-)([0-9]+)$/)?.[1];
    const n = count(value);
    if (n === undefined) return undefined;
    prefix = /^(?:-c|--bytes)/.test(arg) ? { bytes: n } : { lines: n };
  }
  return prefix;
}

/** `sed -n 'Np'`, `sed -n 'M,Np'` and `sed Nq`. */
function sedPrefix(args: readonly string[]): Prefix | undefined {
  if (args.length === 2 && args[0] === "-n") {
    const range = args[1].match(/^([0-9]+)(?:,([0-9]+))?p$/);
    const first = count(range?.[1]);
    const last = count(range?.[2] ?? range?.[1]);
    if (first === undefined || last === undefined || first > last)
      return undefined;
    return { lines: last };
  }
  const quit = args.length === 1 ? count(args[0].match(/^([0-9]+)q$/)?.[1]) : 0;
  return quit ? { lines: quit } : undefined;
}

/** Prefix that `head`/`sed` reads from stdin, or undefined when unknown. */
export function consumerPrefix(
  args: readonly string[],
  name: string,
): Prefix | undefined {
  if (name === "head") return headPrefix(args);
  if (name === "sed") return sedPrefix(args);
  return undefined;
}

/** Only stderr may be redirected: stdout must still feed the consumer. */
const stderrOnly = (node: SimpleCommandNode) =>
  node.redirections.every(
    (r) =>
      r.fd === 2 &&
      (r.operator === ">" || r.operator === ">>" || r.operator === ">&"),
  );

function plainName(ctx: InterpreterContext, node: SimpleCommandNode) {
  const name = node.name && literal(node.name);
  if (!name || name.includes("/")) return undefined;
  if (ctx.state.functions.has(name)) return undefined;
  if (ctx.state.env.has(`BASH_ALIAS_${name}`)) return undefined;
  return name;
}

/**
 * The limit to hand the producer at `index`, or undefined. Only a simple,
 * read-only producer directly followed by a known prefix consumer qualifies.
 */
export function pipelineStdoutLimit(
  ctx: InterpreterContext,
  commands: readonly CommandNode[],
  index: number,
  pipeStderr: boolean,
): PendingStdoutLimit | undefined {
  if (ctx.state.options.pipefail || pipeStderr) return undefined;
  const producer = commands[index];
  const consumer = commands[index + 1];
  if (producer?.type !== "SimpleCommand" || consumer?.type !== "SimpleCommand")
    return undefined;
  if (!stderrOnly(producer)) return undefined;
  const name = plainName(ctx, producer);
  if (!name) return undefined;
  const gitGrep =
    name === "git" &&
    producer.args.length > 0 &&
    literal(producer.args[0]) === "grep";
  if (!gitGrep && !PRODUCERS.has(name)) return undefined;
  const consumerName = plainName(ctx, consumer);
  if (!consumerName) return undefined;
  if (
    consumer.redirections.some((r) => r.operator.startsWith("<") || r.fd === 0)
  )
    return undefined;
  const consumerArgs = consumer.args.map(literal);
  if (consumerArgs.some((arg) => arg === undefined)) return undefined;
  const prefix = consumerPrefix(consumerArgs as string[], consumerName);
  if (!prefix) return undefined;
  if ((prefix.lines ?? prefix.bytes ?? 0) > MAX_PREFIX) return undefined;
  const pending: PendingStdoutLimit = {
    name,
    depth: ctx.substitutionDepth ?? 0,
    stopped: false,
    taken: false,
    limit: createStdoutLimit(prefix, () => {
      pending.stopped = true;
    }),
  };
  return pending;
}

function createStdoutLimit(prefix: Prefix, onStop: () => void): StdoutLimit {
  let scanned = 0;
  let newlines = 0;
  return {
    lines: prefix.lines,
    bytes: prefix.bytes,
    reached(stdout) {
      if (prefix.bytes !== undefined) return stdout.length > prefix.bytes;
      const lines = prefix.lines ?? Number.POSITIVE_INFINITY;
      if (stdout.length < scanned) {
        scanned = 0;
        newlines = 0;
      }
      for (
        let at = stdout.indexOf("\n", scanned);
        at !== -1;
        at = stdout.indexOf("\n", at + 1)
      ) {
        newlines++;
        scanned = at + 1;
        // More than N complete lines: the consumer never reads the rest.
        if (newlines > lines) return true;
      }
      scanned = stdout.length;
      return false;
    },
    stop: onStop,
  };
}

/** Hand the pending limit to the producer's own dispatch, exactly once. */
export function takeStdoutLimit(
  ctx: InterpreterContext,
  commandName: string,
): StdoutLimit | undefined {
  const pending = ctx.state.pipeStdoutLimit;
  if (!pending || pending.taken || pending.name !== commandName)
    return undefined;
  pending.taken = true;
  return pending.limit;
}
