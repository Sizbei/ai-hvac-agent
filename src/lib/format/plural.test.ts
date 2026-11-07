import { describe, it, expect } from "vitest";
import { plural } from "./plural";

describe("plural", () => {
  it("picks the singular for exactly one", () => {
    expect(plural(1, "question", "questions")).toBe("1 question");
    expect(plural(0, "question", "questions")).toBe("0 questions");
    expect(plural(2, "answer isn't a number", "answers aren't numbers")).toBe("2 answers aren't numbers");
  });
});
