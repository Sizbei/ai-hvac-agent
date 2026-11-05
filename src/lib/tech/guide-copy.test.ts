import { describe, it, expect } from "vitest";
import { GUIDE_COPY, progressLabel } from "./guide-copy";

describe("GUIDE_COPY", () => {
  it("pins the surface strings", () => {
    expect(GUIDE_COPY).toMatchObject({
      cardTitle: "Getting started", pageTitle: "Getting started", guideLink: "Guide", back: "Back",
      upNext: "Up next", seeAll: "See all steps", goToJobs: "Go to my jobs", openJob: "Open the job",
      runTitle: "Run a job", furtherTitle: "Go further", leadOnly: "Lead only",
      hideAria: "Hide the guide from your jobs", closeAria: "Close the getting started card",
      progressAria: "Getting started progress", hint: "Tap Guide at the top to see it again.",
      updateFailed: "Couldn't update the guide. Please try again.", loadFailed: "Couldn't load the guide.",
      tryAgain: "Try again", loading: "Loading…",
      finishedTitle: "You've run a job start to finish", finishedRest: "The rest are optional. Pick them up when they're useful.",
      upcomingNote: "Your next job is under Upcoming.", srDone: "Done", srUpNext: "Up next", srTodo: "To do",
    });
    expect(GUIDE_COPY.finishedLines).toEqual(["You started a job", "You finished a job"]);
  });
  it("uses the Unicode ellipsis and no trailing period on the finished title", () => {
    expect(GUIDE_COPY.loading).toBe("Loading…");
    expect(GUIDE_COPY.finishedTitle.endsWith(".")).toBe(false);
  });
});

describe("progressLabel", () => {
  it("formats done of total", () => {
    expect(progressLabel(1, 2)).toBe("1 of 2 done");
    expect(progressLabel(3, 7, "")).toBe("3 of 7");
  });
});
