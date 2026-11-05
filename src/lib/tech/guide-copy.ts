/** Exact UI strings for the getting-started guide (spec §6). Do not reword. */
export const GUIDE_COPY = {
  cardTitle: "Getting started",
  pageTitle: "Getting started",
  guideLink: "Guide",
  back: "Back",
  upNext: "Up next",
  seeAll: "See all steps",
  goToJobs: "Go to my jobs",
  openJob: "Open the job",
  runTitle: "Run a job",
  furtherTitle: "Go further",
  leadOnly: "Lead only",
  hideAria: "Hide the guide from your jobs",
  closeAria: "Close the getting started card",
  progressAria: "Getting started progress",
  hint: "Tap Guide at the top to see it again.",
  updateFailed: "Couldn't update the guide. Please try again.",
  loadFailed: "Couldn't load the guide.",
  tryAgain: "Try again",
  loading: "Loading…",
  finishedTitle: "You've run a job start to finish",
  finishedLines: ["You started a job", "You finished a job"] as const,
  finishedRest: "The rest are optional. Pick them up when they're useful.",
  upcomingNote: "Your next job is under Upcoming.",
  srDone: "Done",
  srUpNext: "Up next",
  srTodo: "To do",
} as const;

/** "1 of 2 done" / "N of 7" labels. */
export function progressLabel(done: number, total: number, suffix = " done"): string {
  return `${done} of ${total}${suffix}`;
}
