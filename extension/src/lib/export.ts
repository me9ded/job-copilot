import { formatSalary } from './extraction/salary';
import type { ApplicationRecord, JobRecord, MatchResult } from './types';

/**
 * CSV cells are quoted, and values that a spreadsheet would treat as formulas
 * (=, +, -, @, tab, CR) are prefixed with an apostrophe to prevent CSV injection
 * from untrusted job text.
 */
export function csvCell(value: unknown): string {
  let s = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export function jobsToCsv(jobs: JobRecord[], matches: Map<string, MatchResult>): string {
  return toCsv(
    ['Title', 'Company', 'Location', 'Arrangement', 'Employment type', 'Salary', 'Match score', 'Saved', 'Dismissed', 'Expired', 'Date posted', 'Last verified', 'URL', 'Apply URL', 'Source'],
    jobs.map((j) => [
      j.title,
      j.company,
      j.location ?? '',
      j.workArrangement,
      j.employmentType ?? '',
      formatSalary(j.salary),
      matches.get(j.id)?.score ?? '',
      j.saved ? 'yes' : 'no',
      j.dismissed ? 'yes' : 'no',
      j.expired ? 'yes' : 'no',
      j.datePosted ?? '',
      j.lastVerifiedAt ?? '',
      j.url,
      j.applyUrl ?? '',
      j.origin,
    ]),
  );
}

export function applicationsToCsv(apps: ApplicationRecord[], jobs: Map<string, JobRecord>): string {
  return toCsv(
    ['Title', 'Company', 'Status', 'Applied at', 'Submission confirmed', 'Follow-up', 'Contacts', 'Notes', 'URL', 'Created', 'Updated'],
    apps.map((a) => {
      const j = jobs.get(a.jobId);
      return [
        j?.title ?? '',
        j?.company ?? '',
        a.status,
        a.appliedAt ?? '',
        a.submissionConfirmed ? 'yes' : 'no',
        a.followUpAt ?? '',
        a.contacts.map((c) => [c.name, c.role, c.email].filter(Boolean).join(' / ')).join('; '),
        a.notes,
        j?.url ?? '',
        a.createdAt,
        a.updatedAt,
      ];
    }),
  );
}
