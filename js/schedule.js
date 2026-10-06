// Published operating hours and headways (timetable estimates, NOT live data).
// Read from operator publications on 2026-10-06; see VERIFICATION.md.
// Periods: [from "HH:MM", to "HH:MM", headway minutes]. Times are Bangkok local.
// `verified: true` means the numbers were read from the operator's own
// publication; `false` means a secondary source only.
// Public holidays are treated as weekdays (holiday calendar not included).

const BTS_PDF = "https://www.ebm.co.th/cms-routemap/WareHouse/TimeTable/GreenLine.pdf";

export const SCHEDULE = {
  "BTS-SUK": {
    hours: ["05:15", "00:15"], verified: true, source: BTS_PDF, effective: "2026-01-01",
    note: "Core section Mo Chit–Samrong; outer sections run less often at peak (5 min).",
    weekday: [["05:15", "07:00", 5], ["07:00", "09:00", 2.5], ["09:00", "09:30", 5], ["09:30", "16:00", 6.5],
      ["16:00", "17:00", 5], ["17:00", "20:00", 2.5], ["20:00", "21:00", 5], ["21:00", "22:00", 6], ["22:00", "24:15", 8]],
    weekend: [["05:15", "08:00", 7], ["08:00", "11:00", 6], ["11:00", "21:00", 4.5], ["21:00", "22:00", 7], ["22:00", "24:15", 8]],
  },
  "BTS-SIL": {
    hours: ["05:30", "00:15"], verified: true, source: BTS_PDF, effective: "2026-01-01",
    weekday: [["05:30", "07:00", 6], ["07:00", "09:00", 3.75], ["09:00", "17:00", 6], ["17:00", "20:00", 3.75],
      ["20:00", "22:00", 6], ["22:00", "24:15", 8]],
    weekend: [["05:30", "09:00", 7], ["09:00", "21:00", 6], ["21:00", "22:00", 7], ["22:00", "24:15", 8]],
  },
  "BTS-GLD": {
    hours: ["06:00", "00:14"], verified: true,
    source: "https://www.ebm.co.th/cms-routemap/WareHouse/TimeTable/GoldLine.pdf", effective: "2023-07-01",
    weekday: [["06:00", "07:00", 15], ["07:00", "16:00", 10], ["16:00", "21:00", 8], ["21:00", "22:00", 10], ["22:00", "24:14", 15]],
    weekend: [["06:00", "10:00", 15], ["10:00", "15:00", 10], ["15:00", "22:00", 8], ["22:00", "23:00", 10], ["23:00", "24:14", 15]],
  },
  "MRT-BL": {
    hours: ["06:00", "24:00"], verified: true, source: "https://metro.bemplc.co.th/MRT-System-Map",
    note: "Operator states 'not more than' these intervals.",
    weekday: [["06:00", "07:00", 7], ["07:00", "09:00", 4], ["09:00", "16:30", 7], ["16:30", "19:30", 4], ["19:30", "24:00", 7]],
    weekend: [["06:00", "07:00", 7], ["07:00", "09:00", 4], ["09:00", "16:30", 7], ["16:30", "19:30", 4], ["19:30", "24:00", 7]],
  },
  "MRT-PP": {
    hours: ["05:30", "24:00"], verified: true, source: "https://metro.bemplc.co.th/MRT-System-Map",
    note: "Weekends and holidays start at 06:00. Operator states 'not more than' these intervals.",
    weekday: [["05:30", "06:30", 9], ["06:30", "08:30", 6], ["08:30", "17:00", 9], ["17:00", "19:30", 6], ["19:30", "24:00", 9]],
    weekend: [["06:00", "06:30", 9], ["06:30", "08:30", 6], ["08:30", "17:00", 9], ["17:00", "19:30", 6], ["19:30", "24:00", 9]],
  },
  "MRT-PK": {
    hours: ["05:27", "24:00"], verified: true,
    source: "https://www.ebm.co.th/cms-routemap/WareHouse/TimeTable/PinkLine.pdf", effective: "2025-09-01",
    weekday: [["05:27", "06:30", 10], ["06:30", "08:30", 5], ["08:30", "16:30", 10], ["16:30", "19:30", 5], ["19:30", "24:00", 10]],
    weekend: [["05:27", "24:00", 10]],
  },
  "MRT-PKB": {
    hours: ["06:00", "24:00"], verified: true,
    source: "https://www.ebm.co.th/cms-routemap/WareHouse/TimeTable/PinkLine.pdf", effective: "2025-09-01",
    note: "Branch figures read from small print; medium confidence.",
    weekday: [["06:00", "07:00", 10], ["07:00", "08:00", 5], ["08:00", "17:00", 10], ["17:00", "18:00", 5], ["18:00", "24:00", 10]],
    weekend: [["06:00", "24:00", 10]],
  },
  "MRT-YL": {
    hours: ["05:30", "24:00"], verified: true,
    source: "https://www.ebm.co.th/cms-routemap/WareHouse/TimeTable/YellowLine.pdf",
    weekday: [["05:30", "07:00", 10], ["07:00", "09:00", 5], ["09:00", "17:00", 10], ["17:00", "20:00", 5], ["20:00", "24:00", 10]],
    weekend: [["05:30", "24:00", 10]],
  },
  ARL: {
    hours: ["05:30", "24:00"], verified: false,
    source: "https://en.wikipedia.org/wiki/Airport_Rail_Link_(Bangkok)",
    note: "Operator site unreachable during verification; figures from secondary sources and the OTP GTFS.",
    weekday: [["05:30", "06:00", 12], ["06:00", "09:00", 10], ["09:00", "16:00", 12], ["16:00", "20:00", 10], ["20:00", "24:00", 12]],
    weekend: [["05:30", "24:00", 12]],
  },
  "SRT-DR": {
    hours: ["05:00", "24:00"], verified: true, source: "https://www.srtet.co.th/th",
    note: "10-minute windows differ by about 30 minutes between directions.",
    weekday: [["05:00", "06:30", 15], ["06:30", "09:30", 10], ["09:30", "16:30", 15], ["16:30", "19:30", 10], ["19:30", "24:00", 15]],
    weekend: [["05:00", "06:30", 15], ["06:30", "09:30", 10], ["09:30", "16:30", 15], ["16:30", "19:30", 10], ["19:30", "24:00", 15]],
  },
  "SRT-LR": {
    hours: ["05:00", "00:16"], verified: true, source: "https://www.srtet.co.th/th",
    weekday: [["05:00", "24:16", 20]],
    weekend: [["05:00", "24:16", 20]],
  },
};
