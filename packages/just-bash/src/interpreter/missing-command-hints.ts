/**
 * Automa: one-line hints appended after "command not found" for commands
 * that agents commonly try but that cannot exist in the browser sandbox.
 * The exit status stays 127 and `command -v` still fails; no command is
 * faked.
 */

const NODE_INSTEAD =
  "use `node -e '...'` or `node file.js` for scripting instead";

const HINTS: Record<string, string> = Object.assign(Object.create(null), {
  python: `Python is not available in this sandbox; ${NODE_INSTEAD}`,
  python2: `Python is not available in this sandbox; ${NODE_INSTEAD}`,
  python3: `Python is not available in this sandbox; ${NODE_INSTEAD}`,
  pip: `pip cannot install packages in this sandbox; ${NODE_INSTEAD}`,
  pip3: `pip cannot install packages in this sandbox; ${NODE_INSTEAD}`,
  perl: `Perl is not available in this sandbox; ${NODE_INSTEAD}`,
  ruby: `Ruby is not available in this sandbox; ${NODE_INSTEAD}`,
  php: `PHP is not available in this sandbox; ${NODE_INSTEAD}`,
});

const PACKAGE_MANAGER =
  "packages cannot be installed in this sandbox; run scripts with `node` " +
  "(existing node_modules can be required)";
for (const name of ["npm", "npx", "pnpm", "yarn", "bun", "deno"]) {
  HINTS[name] = PACKAGE_MANAGER;
}

const NATIVE =
  "this browser sandbox cannot run native programs, system services or " +
  "package installs";
for (const name of [
  "apt",
  "apt-get",
  "brew",
  "sudo",
  "su",
  "docker",
  "podman",
  "kubectl",
  "systemctl",
  "service",
  "ssh",
  "scp",
  "make",
  "cmake",
  "gcc",
  "g++",
  "cc",
  "clang",
  "rustc",
  "cargo",
  "go",
  "java",
  "javac",
  "mvn",
  "gradle",
  "dotnet",
]) {
  HINTS[name] = NATIVE;
}

/** Returns the hint line (with trailing newline) or "" when none applies. */
export function missingCommandHint(commandName: string): string {
  const hint = HINTS[commandName];
  return hint ? `hint: ${hint}\n` : "";
}
