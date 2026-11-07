import { expect, it } from "vitest";
import { Bash } from "./Bash.js";
import { createInitialShellEnvironment } from "./initial-shell-environment.js";

it("startup environment retains overrides and safe dynamic keys", () => {
  const prototype = Object.getOwnPropertyDescriptors(Object.prototype);
  const env = JSON.parse(
    '{"HOME":"/custom","PATH":"./bin","OSTYPE":"custom","BASH_VERSION":"spoofed","BASH_VERSINFO":"spoofed","SHELLOPTS":"spoofed","BASHOPTS":"spoofed","__proto__":"data","constructor":"data","prototype":"data","hasOwnProperty":"data","toString":"data","valueOf":"data"}',
  ) as Record<string, string>;
  const actual = createInitialShellEnvironment({ cwd: "/workspace", env });
  const bash = new Bash({ cwd: "/workspace", env, defenseInDepth: false });
  expect(actual).toEqual(new Map(Object.entries(bash.getEnv())));
  expect(actual.get("HOME")).toBe("/custom");
  expect(actual.get("PATH")).toBe("./bin");
  expect(actual.get("BASH_VERSION")).not.toBe("spoofed");
  expect(actual.has("BASH_VERSINFO")).toBe(false);
  for (const key of [
    "__proto__",
    "constructor",
    "prototype",
    "hasOwnProperty",
    "toString",
    "valueOf",
  ])
    expect(actual.get(key)).toBe("data");
  expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototype);
});

it("default layout retains the original home and startup options", () => {
  const actual = createInitialShellEnvironment({
    cwd: "/home/user",
    defaultLayout: true,
  });
  const bash = new Bash({ defenseInDepth: false });
  expect(actual).toEqual(new Map(Object.entries(bash.getEnv())));
  expect(actual.get("HOME")).toBe("/home/user");
  expect(actual.get("SHELLOPTS")).toBe(
    "braceexpand:hashall:interactive-comments",
  );
  expect(actual.get("BASHOPTS")).toBe("globskipdots");
});
