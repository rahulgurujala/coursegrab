// HTML-escapes a value for safe interpolation into a template string. Shared by every view
// module that still builds markup as strings (courseRow.ts now, courseDetails.ts next).
export function esc(value: unknown): string {
  return String(value == null ? "" : value).replace(
    /[&<>"']/g,
    (c) => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }) as Record<string, string>)[c]!
  );
}
