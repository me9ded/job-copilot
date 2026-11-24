import { z } from 'zod';

/* ----------------------------------------------------------------------------
 * Jobs
 * ------------------------------------------------------------------------- */

export const WorkArrangement = z.enum(['remote', 'hybrid', 'onsite', 'unknown']);
export type WorkArrangement = z.infer<typeof WorkArrangement>;

export const Salary = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
  currency: z.string().optional(),
  period: z.enum(['hour', 'day', 'week', 'month', 'year']).optional(),
  text: z.string().optional(),
});
export type Salary = z.infer<typeof Salary>;

/** Raw result of extracting a posting from a page or API. Untrusted input. */
export const ExtractedJob = z.object({
  title: z.string().max(500),
  company: z.string().max(300),
  location: z.string().max(500).optional(),
  workArrangement: WorkArrangement.default('unknown'),
  employmentType: z.string().max(100).optional(),
  salary: Salary.optional(),
  descriptionText: z.string().max(100_000),
  /** Sanitized HTML. Always re-sanitized before rendering. */
  descriptionHtml: z.string().max(200_000).optional(),
  responsibilities: z.array(z.string().max(2000)).max(200).default([]),
  requiredQualifications: z.array(z.string().max(2000)).max(200).default([]),
  preferredQualifications: z.array(z.string().max(2000)).max(200).default([]),
  datePosted: z.string().max(50).optional(),
  validThrough: z.string().max(50).optional(),
  url: z.string().max(2048),
  applyUrl: z.string().max(2048).optional(),
  adapter: z.string().max(50),
  completeness: z.number().min(0).max(1),
  missingFields: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
});
export type ExtractedJob = z.infer<typeof ExtractedJob>;

export const JobOrigin = z.enum(['page', 'discovery', 'manual', 'selection']);
export type JobOrigin = z.infer<typeof JobOrigin>;

export const JobRecord = ExtractedJob.extend({
  id: z.string(),
  fingerprint: z.string(),
  dedupeKey: z.string(),
  origin: JobOrigin,
  /** For discovery: `${kind}:${token}` of the source that produced it. */
  sourceId: z.string().optional(),
  sourceJobId: z.string().optional(),
  saved: z.boolean().default(false),
  dismissed: z.boolean().default(false),
  savedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastVerifiedAt: z.string().optional(),
  expired: z.boolean().default(false),
  expiredReason: z.string().optional(),
  /** Fields the user corrected manually; never overwritten by re-extraction. */
  userEditedFields: z.array(z.string()).default([]),
  notes: z.string().max(20_000).default(''),
  /** Other URLs that resolved to this same job (duplicate detection). */
  aliasUrls: z.array(z.string()).default([]),
});
export type JobRecord = z.infer<typeof JobRecord>;

/* ----------------------------------------------------------------------------
 * Profile & résumé
 * ------------------------------------------------------------------------- */

export const Seniority = z.enum(['intern', 'entry', 'mid', 'senior', 'staff', 'manager']);
export type Seniority = z.infer<typeof Seniority>;

export const Experience = z.object({
  id: z.string(),
  title: z.string().default(''),
  company: z.string().default(''),
  location: z.string().default(''),
  /** YYYY-MM or YYYY */
  start: z.string().default(''),
  /** YYYY-MM, YYYY, or "present" */
  end: z.string().default(''),
  /** Empty when unknown. Guessed from the title on import; the user can change it. */
  employmentType: z.enum(['', 'full-time', 'part-time', 'internship', 'co-op', 'contract', 'volunteer']).default(''),
  bullets: z.array(z.string()).default([]),
});
export type Experience = z.infer<typeof Experience>;

export const Education = z.object({
  id: z.string(),
  institution: z.string().default(''),
  degree: z.string().default(''),
  field: z.string().default(''),
  start: z.string().default(''),
  end: z.string().default(''),
  details: z.array(z.string()).default([]),
});
export type Education = z.infer<typeof Education>;

export const Project = z.object({
  id: z.string(),
  name: z.string().default(''),
  description: z.string().default(''),
  url: z.string().default(''),
  bullets: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  /** Academic (course, capstone, thesis), personal (side project) or done at work. Empty when unknown. */
  kind: z.enum(['', 'academic', 'personal', 'professional']).default(''),
  start: z.string().default(''),
  end: z.string().default(''),
});
export type Project = z.infer<typeof Project>;

export const Basics = z.object({
  name: z.string().default(''),
  headline: z.string().default(''),
  email: z.string().default(''),
  phone: z.string().default(''),
  location: z.string().default(''),
  links: z.array(z.string()).default([]),
  summary: z.string().default(''),
});
export type Basics = z.infer<typeof Basics>;

/** The résumé content model shared by the canonical profile and tailored versions. */
export const ResumeContent = z.object({
  basics: Basics,
  skills: z.array(z.string()).default([]),
  experience: z.array(Experience).default([]),
  education: z.array(Education).default([]),
  projects: z.array(Project).default([]),
  certifications: z.array(z.string()).default([]),
});
export type ResumeContent = z.infer<typeof ResumeContent>;

export const Preferences = z.object({
  roleTitles: z.array(z.string()).default([]),
  locations: z.array(z.string()).default([]),
  seniority: z.array(Seniority).default([]),
  workArrangements: z.array(WorkArrangement.exclude(['unknown'])).default([]),
  employmentTypes: z.array(z.string()).default([]),
  minSalary: z.number().optional(),
  salaryCurrency: z.string().default('USD'),
  needsSponsorship: z.boolean().default(false),
  willingToRelocate: z.boolean().default(false),
  excludedKeywords: z.array(z.string()).default([]),
});
export type Preferences = z.infer<typeof Preferences>;

export const Profile = ResumeContent.extend({
  /** Incremented on every edit; part of the match cache key. */
  version: z.number().int().nonnegative().default(0),
  updatedAt: z.string().default(''),
  preferences: Preferences.default(Preferences.parse({})),
});
export type Profile = z.infer<typeof Profile>;

export const ResumeVersion = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['original', 'tailored', 'custom']),
  jobId: z.string().optional(),
  content: ResumeContent,
  /** Original extracted text for uploaded files; preserved verbatim. */
  rawText: z.string().optional(),
  sourceFileName: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ResumeVersion = z.infer<typeof ResumeVersion>;

export const CoverLetter = z.object({
  id: z.string(),
  jobId: z.string(),
  body: z.string(),
  generatedBy: z.enum(['template', 'ai', 'manual']),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CoverLetter = z.infer<typeof CoverLetter>;

/* ----------------------------------------------------------------------------
 * Applications
 * ------------------------------------------------------------------------- */

export const APPLICATION_STATUSES = [
  'discovered',
  'saved',
  'to_review',
  'preparing',
  'ready',
  'applied',
  'interviewing',
  'offer',
  'rejected',
  'withdrawn',
] as const;
export const ApplicationStatus = z.enum(APPLICATION_STATUSES);
export type ApplicationStatus = z.infer<typeof ApplicationStatus>;

export const Contact = z.object({
  id: z.string(),
  name: z.string().default(''),
  role: z.string().default(''),
  email: z.string().default(''),
  url: z.string().default(''),
  notes: z.string().default(''),
});
export type Contact = z.infer<typeof Contact>;

export const ApplicationRecord = z.object({
  id: z.string(),
  jobId: z.string(),
  status: ApplicationStatus,
  statusHistory: z.array(z.object({ status: ApplicationStatus, at: z.string() })).default([]),
  /** Only set after the user explicitly confirms submission. */
  appliedAt: z.string().optional(),
  submissionConfirmed: z.boolean().default(false),
  notes: z.string().default(''),
  resumeVersionId: z.string().optional(),
  coverLetterId: z.string().optional(),
  contacts: z.array(Contact).default([]),
  followUpAt: z.string().optional(),
  followUpNotifiedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ApplicationRecord = z.infer<typeof ApplicationRecord>;

/* ----------------------------------------------------------------------------
 * Interview prep
 * ------------------------------------------------------------------------- */

export const PrepItem = z.object({
  id: z.string(),
  category: z.enum(['technical', 'behavioral', 'role', 'gap', 'ask', 'research']),
  question: z.string(),
  why: z.string().default(''),
  suggestedEvidence: z.array(z.string()).default([]),
  notes: z.string().default(''),
  practiced: z.boolean().default(false),
  source: z.enum(['template', 'ai', 'manual']).default('template'),
});
export type PrepItem = z.infer<typeof PrepItem>;

export const InterviewPrep = z.object({
  jobId: z.string(),
  items: z.array(PrepItem),
  updatedAt: z.string(),
});
export type InterviewPrep = z.infer<typeof InterviewPrep>;

/* ----------------------------------------------------------------------------
 * Settings
 * ------------------------------------------------------------------------- */

export const MatchWeights = z.object({
  requiredSkills: z.number().min(0).max(10).default(4.5),
  preferredSkills: z.number().min(0).max(10).default(1.5),
  experience: z.number().min(0).max(10).default(1.5),
  seniority: z.number().min(0).max(10).default(1),
  location: z.number().min(0).max(10).default(1),
  education: z.number().min(0).max(10).default(0.5),
});
export type MatchWeights = z.infer<typeof MatchWeights>;

export const DiscoverySourceKind = z.enum(['greenhouse', 'lever', 'ashby']);
export type DiscoverySourceKind = z.infer<typeof DiscoverySourceKind>;

export const DiscoverySource = z.object({
  id: z.string(),
  kind: DiscoverySourceKind,
  token: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
  label: z.string().default(''),
  titleFilter: z.string().default(''),
  enabled: z.boolean().default(true),
  lastRunAt: z.string().optional(),
  lastError: z.string().optional(),
  lastCount: z.number().optional(),
});
export type DiscoverySource = z.infer<typeof DiscoverySource>;

export const AI_PROVIDER_IDS = ['none', 'ollama', 'openai_compatible', 'backend'] as const;
export const AiProviderId = z.enum(AI_PROVIDER_IDS);
export type AiProviderId = z.infer<typeof AiProviderId>;

export const AI_FEATURES = ['matchExplain', 'resumeTailor', 'coverLetter', 'interviewPrep', 'applicationAnswers'] as const;
export const AiFeature = z.enum(AI_FEATURES);
export type AiFeature = z.infer<typeof AiFeature>;

export const Pricing = z.object({
  /** USD per 1M input tokens, entered by the user from their provider's price page. */
  inputPerMTok: z.number().min(0).default(0),
  outputPerMTok: z.number().min(0).default(0),
});

export const AiSettings = z.object({
  features: z
    .object({
      matchExplain: AiProviderId.default('none'),
      resumeTailor: AiProviderId.default('none'),
      coverLetter: AiProviderId.default('none'),
      interviewPrep: AiProviderId.default('none'),
      applicationAnswers: AiProviderId.default('none'),
    })
    .default({ matchExplain: 'none', resumeTailor: 'none', coverLetter: 'none', interviewPrep: 'none', applicationAnswers: 'none' }),
  ollama: z
    .object({ baseUrl: z.string().default('http://localhost:11434'), model: z.string().default('llama3.1:8b') })
    .default({ baseUrl: 'http://localhost:11434', model: 'llama3.1:8b' }),
  openaiCompatible: z
    .object({ baseUrl: z.string().default('http://localhost:1234'), model: z.string().default('local-model') })
    .default({ baseUrl: 'http://localhost:1234', model: 'local-model' }),
  backend: z
    .object({
      baseUrl: z.string().default('http://localhost:8787'),
      /** Token for the user's own backend; not a third-party provider key. */
      token: z.string().default(''),
      model: z.string().default(''),
      /** User acknowledged that profile/job text is sent to their backend and its provider. */
      consented: z.boolean().default(false),
    })
    .default({ baseUrl: 'http://localhost:8787', token: '', model: '', consented: false }),
  pricing: z
    .object({ ollama: Pricing, openai_compatible: Pricing, backend: Pricing })
    .default({
      ollama: { inputPerMTok: 0, outputPerMTok: 0 },
      openai_compatible: { inputPerMTok: 0, outputPerMTok: 0 },
      backend: { inputPerMTok: 0, outputPerMTok: 0 },
    }),
  limits: z
    .object({
      dailyRequests: z.number().int().min(0).default(40),
      monthlyTokens: z.number().int().min(0).default(1_000_000),
    })
    .default({ dailyRequests: 40, monthlyTokens: 1_000_000 }),
  timeoutMs: z.number().int().min(5_000).max(300_000).default(90_000),
  maxRetries: z.number().int().min(0).max(4).default(2),
  cacheTtlHours: z.number().min(0).default(24 * 14),
});
export type AiSettings = z.infer<typeof AiSettings>;

/** The file as uploaded (stored under `file:<resumeId>`), so autofill can attach the user's own PDF. */
export const StoredFile = z.object({
  name: z.string().max(255),
  type: z.string().max(100),
  size: z.number().int().nonnegative(),
  base64: z.string().max(14_000_000),
  savedAt: z.string(),
});
export type StoredFile = z.infer<typeof StoredFile>;

export const AUTOFILL_KEYS = ['firstName', 'lastName', 'fullName', 'email', 'phone', 'location', 'city', 'linkedin', 'github', 'website', 'currentTitle', 'currentCompany', 'school', 'degree', 'discipline'] as const;
export type AutofillKey = (typeof AUTOFILL_KEYS)[number];

/** Screening questions answered only from what the user typed in Settings → Applications. */
export const STANDARD_QUESTIONS = [
  'workAuthorized',
  'sponsorship',
  'relocate',
  'over18',
  'salary',
  'startDate',
  'yearsExperience',
  'hearAbout',
  'gender',
  'race',
  'hispanic',
  'veteran',
  'disability',
  'pronouns',
] as const;
export type StandardQuestion = (typeof STANDARD_QUESTIONS)[number];

export const SavedAnswer = z.object({
  id: z.string(),
  /** The question as it appeared on a form. Matched by wording against later questions. */
  question: z.string().min(1).max(500),
  answer: z.string().max(5000),
});
export type SavedAnswer = z.infer<typeof SavedAnswer>;

export const AutofillSettings = z.object({
  /** Press Next / Continue and fill each step until the final submit button. */
  advance: z.boolean().default(true),
  /** Tick "I agree / I acknowledge / I certify" boxes. Off by default: that's the user's own attestation. */
  tickConsent: z.boolean().default(false),
  standardAnswers: z.partialRecord(z.enum(STANDARD_QUESTIONS), z.string().max(500)).default({}),
  savedAnswers: z.array(SavedAnswer).max(500).default([]),
  /** "auto": the uploaded original if there is one, else a PDF generated from the profile. Otherwise "none", "profile" or a résumé version id. */
  attach: z.string().max(100).default('auto'),
  /** Replace values already typed into the form. Off by default. */
  overwrite: z.boolean().default(false),
  /** Values the user corrected (e.g. how a name splits into first / last). Empty means "use the profile". */
  overrides: z.partialRecord(z.enum(AUTOFILL_KEYS), z.string().max(500)).default({}),
});
export type AutofillSettings = z.infer<typeof AutofillSettings>;

/** One autofill run, for the Home tab. Holds no form values. */
export const AutofillLogEntry = z.object({
  at: z.string(),
  host: z.string().max(200),
  jobTitle: z.string().max(200).default(''),
  company: z.string().max(200).default(''),
  filled: z.number().int().min(0),
  stop: z.string().max(40),
});
export type AutofillLogEntry = z.infer<typeof AutofillLogEntry>;

export const Settings = z.object({
  weights: MatchWeights.default(MatchWeights.parse({})),
  /** Upper bound applied to the score when a hard deal-breaker is present. */
  dealBreakerCap: z.number().min(0).max(100).default(40),
  staleAfterDays: z.number().int().min(1).default(21),
  showOnPageButton: z.boolean().default(true),
  /** Extra origins (e.g. https://careers.example.com) the user enabled for the generic extractor. */
  customSites: z.array(z.string()).default([]),
  discovery: z
    .object({
      enabled: z.boolean().default(false),
      refreshHours: z.number().min(1).max(168).default(12),
      sources: z.array(DiscoverySource).default([]),
      notifyMinScore: z.number().min(0).max(100).default(80),
      lastRunAt: z.string().optional(),
    })
    .default({ enabled: false, refreshHours: 12, sources: [], notifyMinScore: 80 }),
  notifications: z
    .object({ followUps: z.boolean().default(false), newMatches: z.boolean().default(false) })
    .default({ followUps: false, newMatches: false }),
  ai: AiSettings.default(AiSettings.parse({})),
  autofill: AutofillSettings.default(AutofillSettings.parse({})),
});
export type Settings = z.infer<typeof Settings>;

/* ----------------------------------------------------------------------------
 * Matching
 * ------------------------------------------------------------------------- */

export interface ComponentScore {
  key: keyof MatchWeights;
  label: string;
  /** 0..1, or null when the component does not apply to this job. */
  score: number | null;
  weight: number;
  /** Points contributed to the final 0..100 score. */
  contribution: number;
  detail: string;
}

export interface SkillHit {
  skill: string;
  /** Where the evidence was found in the profile. */
  evidence: string[];
  /** 1 for exact, <1 for related/transferable skills. */
  credit: number;
  relatedVia?: string;
}

export interface DealBreaker {
  code: string;
  message: string;
  /** Hard deal-breakers cap the score; soft ones are warnings only. */
  severity: 'hard' | 'soft';
}

export interface RelevantItem {
  kind: 'experience' | 'project';
  id: string;
  label: string;
  matchedSkills: string[];
}

export interface MatchResult {
  score: number;
  rawScore: number;
  capped: boolean;
  components: ComponentScore[];
  requiredMatched: SkillHit[];
  requiredMissing: string[];
  preferredMatched: SkillHit[];
  preferredMissing: string[];
  dealBreakers: DealBreaker[];
  relevant: RelevantItem[];
  suggestions: string[];
  explanation: string;
  /** True when no explicit requirements section was found and skills were inferred from the full text. */
  inferredRequirements: boolean;
  cacheKey: string;
  computedAt: string;
}
