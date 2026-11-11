import { describe, expect, it } from "vitest";
import { clockLabel, minutesLabel, spokenDuration, TUTORIAL_VIDEO } from "./tutorial-video";

describe("tutorial video labels", () => {
  it("formats m:ss with a padded second", () => {
    expect(clockLabel(192)).toBe("3:12");
    expect(clockLabel(65)).toBe("1:05");
    expect(clockLabel(59.6)).toBe("1:00");
    expect(clockLabel(-3)).toBe("0:00");
  });

  it("rounds to whole minutes, never below one", () => {
    expect(minutesLabel(192)).toBe("3-minute");
    expect(minutesLabel(210)).toBe("4-minute");
    expect(minutesLabel(20)).toBe("1-minute");
  });

  it("speaks the length for screen readers", () => {
    expect(spokenDuration(192)).toBe("3 minutes 12 seconds");
    expect(spokenDuration(60)).toBe("1 minute");
    expect(spokenDuration(61)).toBe("1 minute 1 second");
    expect(spokenDuration(0)).toBe("0 seconds");
  });

  it("serves every file from public/tutorial", () => {
    for (const path of [TUTORIAL_VIDEO.src, TUTORIAL_VIDEO.poster, TUTORIAL_VIDEO.captions]) {
      expect(path.startsWith("/tutorial/")).toBe(true);
    }
  });
});
