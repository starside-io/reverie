/**
 * Plain words for what the tools return. Trust, kind and state are shown as
 * text, never as a coloured chip.
 */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-12-24" as "24 December 2026". The day is a calendar day, not an instant. */
export function longDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return day;
  return `${date} ${MONTHS[month - 1]} ${year}`;
}

/** "2026-12" as "December 2026". */
export function longMonth(month: string): string {
  const [year, index] = month.split("-").map(Number);
  if (!year || !index) return month;
  return `${MONTHS[index - 1]} ${year}`;
}

/** An instant, as the owner's local date and time. */
export function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Today in the owner's time zone, as a calendar day. */
export function today(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Entries grouped under the day they happened, keeping the order they came in. */
export function byDay<T extends { occurredOn: string }>(items: readonly T[]): Array<{ day: string; items: T[] }> {
  const groups: Array<{ day: string; items: T[] }> = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.day === item.occurredOn) last.items.push(item);
    else groups.push({ day: item.occurredOn, items: [item] });
  }
  return groups;
}

/** A score or a factor, to two decimals. */
export function figure(value: number | null | undefined): string {
  return value === null || value === undefined || Number.isNaN(value) ? "n/a" : value.toFixed(2);
}

const VERBS: Record<string, string> = {
  "memory.remember": "Add",
  "memory.update": "Refine",
  "memory.supersede": "Supersede",
  "memory.add_source": "Duplicate, add as a source",
  "memory.merge": "Merge",
  "memory.retire": "Retire",
  "memory.link": "Link",
  "memory.pin": "Pin",
  "memory.promote_procedure": "Add a procedure",
  "memory.set_tags": "Tag",
  "memory.shelve": "Shelve",
};

/** The reconcile verb or action a proposal stands for, from the tool it would run. */
export function verbOf(tool: string): string {
  return VERBS[tool] ?? tool;
}

/** Turns a typed tag ("#NightStash", "night stash") into the slug the host keeps. */
export function slugOf(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/\s+/g, "-");
}
