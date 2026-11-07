/**
 * Private fixed-query building blocks. This entry has no Shell interpreter,
 * command dispatch, JavaScript runtime, or authority to execute a script.
 * Consumers must admit the complete AST and command options before effects,
 * and supply request-scoped filesystem, cancellation and resource capabilities.
 */
export type * from "./ast/types.js";
export { catCommand } from "./commands/cat/cat.js";
export { parseCatArgs } from "./commands/cat/options.js";
export { findCommand } from "./commands/find/find.js";
export {
  collectNewerRefs,
  evaluateExpressionWithPrune,
  evaluateForEarlyPrune,
  evaluateSimpleExpression,
  expressionHasPrune,
  expressionNeedsEmptyCheck,
  expressionNeedsStatMetadata,
  isSimpleExpression,
} from "./commands/find/matcher.js";
export { parseExpressions as parseFindExpressions } from "./commands/find/parser.js";
export type {
  EvalContext as FindEvalContext,
  EvalResult as FindEvalResult,
  Expression as FindExpression,
  FindAction,
  ParseResult as FindParseResult,
} from "./commands/find/types.js";
export { grepCommand } from "./commands/grep/grep.js";
export { headCommand } from "./commands/head/head.js";
export { selectFromByteReader } from "./commands/head/head-tail-reader.js";
export {
  type HeadTailOptions,
  type HeadTailParseResult,
  parseHeadTailArgs,
} from "./commands/head/head-tail-shared.js";
export { printfCommand } from "./commands/printf/printf.js";
export { tailCommand } from "./commands/tail/tail.js";
export { parseWcArgs } from "./commands/wc/options.js";
export { wcCommand } from "./commands/wc/wc.js";
export {
  type CommandContextOptions,
  createCommandContext,
} from "./custom-commands.js";
export type {
  CommandExecutionBudget,
  ResourceLease,
} from "./execution-scope.js";
export type { IFileSystem } from "./fs/interface.js";
export {
  createInitialShellEnvironment,
  DEFAULT_PATH,
  HOST_VARS,
  type InitialShellEnvironmentOptions,
} from "./initial-shell-environment.js";
export {
  type CommandResolutionContext,
  type ResolveCommandResult,
  resolveCommand,
} from "./interpreter/command-resolution.js";
export {
  ExecutionAbortedError,
  ExecutionLimitError,
} from "./interpreter/errors.js";
export { SHELL_BUILTINS } from "./interpreter/helpers/shell-constants.js";
export { type ExecutionLimits, resolveLimits } from "./limits.js";
export { createOutputPresenter } from "./output-presentation.js";
export type { LexerOptions } from "./parser/lexer.js";
export { ParseException, parse as parseShell } from "./parser/parser.js";
export type {
  ExecResult,
  RuntimeCommand,
  RuntimeCommandContext,
} from "./types.js";
