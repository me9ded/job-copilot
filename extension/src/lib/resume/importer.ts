import { addOriginalResume, deleteResume, getProfile, listResumes, putResumeFile, saveProfile } from '../storage/repo';
import type { Profile, ResumeContent, ResumeVersion, StoredFile } from '../types';
import { bytesToBase64, nowIso, uid } from '../util';
import { FILE_TYPES, readResumeFile, type ResumeFileKind } from './files';
import { applyImport, findFamily, type ImportPlan } from './merge';
import { normalizeContent } from './normalize';
import { parseResumeText, type ParsedResume } from './parse';

/**
 * Résumé ingestion pipeline and storage manager:
 * file → text (files.ts) → sections and fields (parse.ts) → tidy (normalize.ts)
 * → review (merge.ts + the review screen) → saved here, only once confirmed.
 * Everything stays in the browser.
 */

export interface ResumeDraft {
  fileName?: string;
  kind: ResumeFileKind;
  pages?: number;
  rawText: string;
  /** The uploaded PDF / DOCX itself, kept locally so autofill can attach it. */
  file?: StoredFile;
  /** Parsed and normalised; nothing saved yet. */
  parsed: ParsedResume;
  /** Problems with the file itself (scanned pages, undecodable characters). */
  fileWarnings: string[];
}

function draftFrom(rawText: string, meta: Omit<ResumeDraft, 'rawText' | 'parsed'>): ResumeDraft {
  const parsed = parseResumeText(rawText);
  return { ...meta, rawText, parsed: { ...parsed, content: normalizeContent(parsed.content) } };
}

/** Reads and parses an uploaded file. Throws ResumeFileError with a user-facing message when it can't be read. */
export async function readResumeDraft(file: { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }): Promise<ResumeDraft> {
  const read = await readResumeFile(file);
  const stored = read.kind === 'text' ? undefined : { name: file.name, type: FILE_TYPES[read.kind], size: read.data.length, base64: bytesToBase64(read.data), savedAt: nowIso() };
  return draftFrom(read.text, { fileName: file.name, kind: read.kind, pages: read.pages, file: stored, fileWarnings: read.warnings });
}

/** Parses pasted résumé text. */
export function textResumeDraft(text: string, fileName?: string): ResumeDraft {
  return draftFrom(text, { fileName, kind: 'text', fileWarnings: [] });
}

/** The earlier upload this draft is a new version of, if any. */
export async function draftFamily(draft: ResumeDraft, content: ResumeContent): Promise<ResumeVersion | undefined> {
  const originals = (await listResumes()).filter((r) => r.kind === 'original');
  return findFamily(originals, draft.fileName, content);
}

/**
 * Saves a reviewed import: the original (verbatim text, the parsed content as
 * corrected in review, and the file) and the merged profile. If the profile
 * can't be saved, the stored original is removed again.
 */
export async function commitResumeImport(
  draft: ResumeDraft,
  content: ResumeContent,
  plan: ImportPlan,
  opts: { replace?: boolean; family?: string } = {},
): Promise<{ profile: Profile; resume: ResumeVersion }> {
  const now = nowIso();
  const id = uid('res');
  const resume = await addOriginalResume({
    id,
    name: `Original — ${draft.fileName ?? 'pasted text'}`,
    kind: 'original',
    content,
    rawText: draft.rawText,
    sourceFileName: draft.fileName,
    family: opts.family ?? id,
    fileKind: draft.kind,
    pages: draft.pages,
    createdAt: now,
    updatedAt: now,
  });
  try {
    if (draft.file) await putResumeFile(id, draft.file);
    const profile = await saveProfile(applyImport(await getProfile(), plan, id, { replace: opts.replace }));
    return { profile, resume };
  } catch (e) {
    await deleteResume(id).catch(() => undefined);
    throw e;
  }
}
