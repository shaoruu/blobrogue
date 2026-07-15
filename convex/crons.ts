import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.hourly(
  "clean consumed run receipts",
  { minuteUTC: 17 },
  internal.runReceipt.cleanup,
);

export default crons;
