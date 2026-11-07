import {
  buildBashopts,
  buildShellopts,
} from "./interpreter/helpers/shellopts.js";
import type { ShellOptions, ShoptOptions } from "./interpreter/types.js";
import { BASH_VERSION } from "./shell-metadata.js";

export const DEFAULT_PATH = "/usr/bin:/bin";

/** Host defaults apply only when the supplied environment does not override them. */
export const HOST_VARS: ReadonlyArray<readonly [string, string]> = [
  ["OSTYPE", "linux-gnu"],
  ["MACHTYPE", "x86_64-pc-linux-gnu"],
  ["HOSTTYPE", "x86_64"],
  ["HOSTNAME", "localhost"],
];

export const INITIAL_SHELL_OPTIONS: Readonly<ShellOptions> = Object.freeze({
  errexit: false,
  pipefail: false,
  nounset: false,
  xtrace: false,
  verbose: false,
  posix: false,
  allexport: false,
  noclobber: false,
  noglob: false,
  noexec: false,
  vi: false,
  emacs: false,
});

export const INITIAL_SHOPT_OPTIONS: Readonly<ShoptOptions> = Object.freeze({
  extglob: false,
  dotglob: false,
  nullglob: false,
  failglob: false,
  globstar: false,
  globskipdots: true,
  nocaseglob: false,
  nocasematch: false,
  expand_aliases: false,
  lastpipe: false,
  xpg_echo: false,
});

export interface InitialShellEnvironmentOptions {
  cwd: string;
  env?: Readonly<Record<string, string>>;
  defaultLayout?: boolean;
}

/** The constructor and fixed query entry share the same startup environment. */
export function createInitialShellEnvironment({
  cwd,
  env,
  defaultLayout = false,
}: InitialShellEnvironmentOptions): Map<string, string> {
  const result = new Map<string, string>([
    ["HOME", defaultLayout ? "/home/user" : "/"],
    ["PATH", DEFAULT_PATH],
    ["IFS", " \t\n"],
    ...HOST_VARS,
    ["PWD", cwd],
    ["OLDPWD", cwd],
    ["OPTIND", "1"],
    ...Object.entries(env ?? {}),
    ["BASH_VERSION", BASH_VERSION],
  ]);
  result.delete("BASH_VERSINFO");
  result.set("SHELLOPTS", buildShellopts(INITIAL_SHELL_OPTIONS));
  result.set("BASHOPTS", buildBashopts(INITIAL_SHOPT_OPTIONS));
  return result;
}
