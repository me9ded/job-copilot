import type { AiProviderId } from '../../lib/types';
import { updateSettings } from '../../lib/storage/repo';
import { ValuesEditor } from '../autofill';
import { Alert, Button, Card, Checkbox, Loading, Select } from '../components';
import { useSettings } from '../hooks';
import { Icon } from '../icons';
import { ApplicationsSection, PROVIDER_LABEL } from '../views/Settings';
import { openDashboard } from './shared';

/** The settings that matter while applying. Everything else lives in the dashboard. */
export function SettingsTab() {
  const settings = useSettings();
  if (!settings) return <Loading />;
  const s = settings.autofill;
  const set = (patch: Partial<typeof s>) => void updateSettings((x) => ({ ...x, autofill: { ...x.autofill, ...patch } }));
  const provider = settings.ai.features.applicationAnswers;
  return (
    <div className="flex flex-col gap-3">
      <Card title="Autofill">
        <div className="flex flex-col gap-2">
          <Checkbox label="Go through every step" hint="Press Next / Continue and keep filling until the final Submit, which is always left to you." checked={s.advance} onChange={(advance) => set({ advance })} />
          <Checkbox label="Replace what’s already typed" hint="Off: fields that already have a value are kept." checked={s.overwrite} onChange={(overwrite) => set({ overwrite })} />
        </div>
      </Card>

      <Card title="Written answers" subtitle="How suggested answers are drafted">
        <div className="flex flex-col gap-2 text-[12.5px]">
          <p className="text-muted">By default, answers are put together from your own résumé bullets, with no AI and nothing sent anywhere. You can let an AI provider polish a draft when you press “Improve with AI”.</p>
          <Select
            aria-label="AI for written answers"
            value={provider}
            onChange={(e) => {
              const p = e.target.value as AiProviderId;
              void updateSettings((x) => ({ ...x, ai: { ...x.ai, features: { ...x.ai.features, applicationAnswers: p } } }));
            }}
          >
            {(Object.keys(PROVIDER_LABEL) as AiProviderId[]).map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABEL[p]}
              </option>
            ))}
          </Select>
          {provider !== 'none' && (
            <Alert tone="neutral" action={<Button size="sm" onClick={() => openDashboard('settings')}>Set up</Button>}>
              The question, the job and your profile text go to {PROVIDER_LABEL[provider]} only when you press Improve with AI. Set its address and model in the dashboard’s Settings → AI.
            </Alert>
          )}
        </div>
      </Card>

      <ApplicationsSection settings={settings} />

      <Card title="What Autofill types into forms">
        <ValuesEditor settings={s} />
      </Card>

      <Card title="More">
        <div className="flex flex-col items-start gap-1">
          {[
            ['settings', 'Job sites, matching, alerts and AI providers'],
            ['studio', 'Résumé Studio: tailored versions and cover letters'],
            ['prep', 'Interview prep'],
            ['saved', 'Saved jobs and discovery'],
          ].map(([hash, label]) => (
            <Button key={hash} size="sm" variant="ghost" icon={<Icon.External size={13} />} onClick={() => openDashboard(hash)}>
              {label}
            </Button>
          ))}
        </div>
        <p className="mt-2 text-[11.5px] text-muted">Export or delete all your data from the dashboard’s Settings → Data. Everything is stored only in this browser.</p>
      </Card>
    </div>
  );
}
