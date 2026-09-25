// The page's version. When the page changes, add a new entry at the top: a higher number, the date, and what changed.
// The exact time shown next to the version is read from GitHub: when this file was last uploaded.
window.LEDGER_VERSION = [
  { version: "1.5", date: "2026-09-21", changes: [
    "Lender view: confirm or reject a payment on the page, after downloading its proof.",
    "Lender view: the ledger updates straight away when a key allows it, instead of waiting for the next hour." ] },
  { version: "1.4", date: "2026-09-21", changes: [
    "Budget: download the blank Family budget tracker from the page.",
    "Budget: clearer message when an uploaded workbook can't be read, naming the tabs it has." ] },
  { version: "1.3", date: "2026-09-21", changes: [
    "A read-only lender view for Veronica: family overview, every entity's statement and budget, payments waiting to be confirmed, and proofs of payment to download." ] },
  { version: "1.2", date: "2026-09-21", changes: [
    "The version at the top now shows the exact date and time it was published." ] },
  { version: "1.1", date: "2026-09-21", changes: [
    "Shows the page's version and date next to the title, with this list of changes." ] },
  { version: "1.0", date: "2026-09-21", changes: [
    "First version: statement, sending payments with proof, budget workbook, and access requests between entities." ] }
];
