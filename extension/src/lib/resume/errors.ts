/** A résumé file that can't be read, with a message written for the user. */
export class ResumeFileError extends Error {
  override name = 'ResumeFileError';
}
