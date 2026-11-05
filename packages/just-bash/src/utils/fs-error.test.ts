import { expect, it } from "vitest";
import { fsErrorMessage } from "./fs-error.js";

it("does not treat inherited properties as errno codes", () => {
  expect(fsErrorMessage({ code: "constructor" })).toBe(
    "No such file or directory",
  );
});
