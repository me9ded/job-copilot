import { useRef, useState } from 'react';
import { RESUME_ACCEPT } from '../../lib/resume/files';
import { readResumeDraft, type ResumeDraft } from '../../lib/resume/importer';
import { errorMessage } from '../../lib/util';
import { Alert, Button, cx } from '../components';
import { Icon } from '../icons';

/**
 * Résumé upload: drop a file or choose one. The file is read and parsed on
 * this device; the result goes to the review screen and nothing is saved yet.
 */
export function ResumeDrop({ onDraft, inputId = 'resume-file', label = 'Choose a file', hint, compact = false }: { onDraft: (d: ResumeDraft) => void; inputId?: string; label?: string; hint?: string; compact?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  const read = async (files: FileList | null | undefined) => {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onDraft(await readResumeDraft(file));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = '';
    }
  };

  return (
    <div
      className={cx('rounded-lg border border-dashed text-center transition-colors', compact ? 'px-3 py-2.5' : 'px-3 py-4', over ? 'border-accent bg-accent-soft' : 'border-line-strong bg-subtle/60')}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void read(e.dataTransfer.files);
      }}
      aria-busy={busy || undefined}
    >
      <input ref={ref} id={inputId} type="file" className="sr-only" accept={RESUME_ACCEPT} onChange={(e) => void read(e.target.files)} />
      {!compact && (
        <span className="mx-auto mb-1.5 flex h-8 w-8 items-center justify-center rounded-full bg-surface text-accent">
          <Icon.Upload size={16} />
        </span>
      )}
      <p className="text-[13px] font-medium">{busy ? 'Reading your résumé…' : 'Drop your résumé here'}</p>
      <p className="mb-2 text-[11.5px] text-muted">{hint ?? 'PDF, DOCX or TXT, up to 10 MB. Read on this device; nothing is uploaded.'}</p>
      <Button size="sm" variant="primary" busy={busy} icon={<Icon.Upload size={13} />} onClick={() => ref.current?.click()}>
        {label}
      </Button>
      {error && (
        <div className="mt-2 text-left">
          <Alert tone="bad">{error}</Alert>
        </div>
      )}
    </div>
  );
}
