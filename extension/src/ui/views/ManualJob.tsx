import { useEffect, useState } from 'react';
import { applyUserEdits, findDuplicate } from '../../lib/jobs';
import { putJob, setJobSaved, upsertJob } from '../../lib/storage/repo';
import type { ExtractedJob, JobRecord } from '../../lib/types';
import { nowIso } from '../../lib/util';
import { Alert, Button, Dialog, useToast } from '../components';
import { useAction, useJobs } from '../hooks';
import { JobForm, formToJob, jobToForm, validateJobForm, type JobFormValue } from '../job-parts';

/** Manual entry for pasted text, restricted sites and corrections of detected jobs. */
export function ManualJobDialog({ open, seed, onClose }: { open: boolean; seed?: Partial<ExtractedJob> & Partial<Pick<JobRecord, 'id'>>; onClose: () => void }) {
  const [value, setValue] = useState<JobFormValue>(jobToForm(seed));
  const jobs = useJobs();
  const toast = useToast();
  useEffect(() => {
    if (open) setValue(jobToForm(seed));
  }, [open, seed]);
  const save = useAction(async () => {
    const invalid = validateJobForm(value);
    if (invalid) throw new Error(invalid);
    const existing = seed && 'id' in seed && seed.id ? jobs?.find((j) => j.id === seed.id) : jobs && seed?.url ? findDuplicate({ ...formToJob(value, 'manual'), url: seed.url }, jobs)?.job : undefined;
    const fresh = formToJob(value, seed?.adapter ?? 'manual', seed as ExtractedJob | undefined);
    if (existing) {
      // Corrections are recorded as user edits so re-extraction never overwrites them.
      const edits: Partial<JobRecord> = {};
      for (const k of ['title', 'company', 'location', 'workArrangement', 'employmentType', 'salary', 'descriptionText', 'responsibilities', 'requiredQualifications', 'preferredQualifications', 'applyUrl'] as const) {
        if (JSON.stringify(existing[k]) !== JSON.stringify(fresh[k])) (edits as Record<string, unknown>)[k] = fresh[k];
      }
      await putJob({ ...applyUserEdits(existing, edits), completeness: fresh.completeness, missingFields: fresh.missingFields, warnings: fresh.warnings, saved: true, savedAt: existing.savedAt ?? nowIso() });
      await setJobSaved(existing.id, true);
    } else {
      const { job } = await upsertJob(fresh, seed?.adapter && seed.adapter !== 'manual' ? 'page' : 'manual', { saved: true, savedAt: nowIso(), userEditedFields: seed?.title ? ['title', 'company'] : [] });
      await setJobSaved(job.id, true);
    }
    toast('Job saved', 'good');
    onClose();
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={seed?.title ? 'Correct job details' : 'Add a job manually'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={save.busy} onClick={() => void save.run()}>
            Save job
          </Button>
        </>
      }
    >
      {save.error && (
        <div className="mb-2">
          <Alert tone="bad">{save.error}</Alert>
        </div>
      )}
      <JobForm value={value} onChange={setValue} />
    </Dialog>
  );
}
