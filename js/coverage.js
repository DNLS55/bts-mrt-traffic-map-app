// Coverage of verified, permitted data per line (checked 2026-10-06).
// s: "yes" verified & used | "no" not available | "blocked" exists but not permitted/unverified
const C = (s, t) => ({ s, t });
const coords = C("yes", "Yes");
const conn = C("yes", "Yes");
const tta = C("blocked", "Exists, not permitted");
const none = C("no", "None found");
const tt = C("yes", "Headways");
export const COVERAGE = {
  columns: ["Stations", "Connections", "Live arrivals", "Live positions", "Timetable"],
  rows: [
    { line: "BTS-SUK", cells: [coords, conn, tta, none, tt] },
    { line: "BTS-SIL", cells: [coords, conn, tta, none, tt] },
    { line: "BTS-GLD", cells: [coords, conn, tta, none, tt] },
    { line: "MRT-BL", cells: [coords, conn, none, none, tt] },
    { line: "MRT-PP", cells: [coords, conn, none, none, tt] },
    { line: "MRT-PK", cells: [coords, conn, tta, none, tt] },
    { line: "MRT-PKB", cells: [C("yes", "Yes (GTFS)"), conn, tta, none, C("yes", "Headways (medium confidence)")] },
    { line: "MRT-YL", cells: [coords, conn, tta, none, tt] },
    { line: "ARL", cells: [coords, conn, none, none, C("blocked", "Unverified")] },
    { line: "SRT-DR", cells: [coords, conn, none, none, tt] },
    { line: "SRT-LR", cells: [C("yes", "Yes (GTFS)"), conn, none, none, tt] },
  ],
  note: "“Exists, not permitted”: the BTS-group arrival service behind the operator's app is encrypted and key-protected, so it isn't used. No public live train-position data was found for any line, so no live trains are shown.",
};

// Why each line has no live arrivals in the app (checked 2026-10-06).
const TTA = "The operator has live arrival times (BTS group TTA service), but access is encrypted and key-protected and no licence allows reuse. Needs written permission from BTSC/EBM.";
const NONE = (who) => `No live arrival data is published by ${who}.`;
export const LIVE_REASON = {
  "BTS-SUK": TTA, "BTS-SIL": TTA, "MRT-YL": TTA, "MRT-PK": TTA, "MRT-PKB": TTA,
  "BTS-GLD": "No live arrival data found for the Gold Line (not shown even on the operator's site).",
  "MRT-BL": NONE("BEM for the Blue Line"), "MRT-PP": NONE("BEM for the Purple Line"),
  ARL: NONE("the Airport Rail Link operator"), "SRT-DR": NONE("SRTET for the Red Lines"), "SRT-LR": NONE("SRTET for the Red Lines"),
};
