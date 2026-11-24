import type { AutofillKey, StandardQuestion } from '../../types';
import type { Descriptor, Question } from './discover';
import { OTHER_DOC_RE } from './discover';
import { normalize } from './text';

/**
 * Field classification: what a field asks for, judged from weighted
 * evidence (a field's own label outweighs its name, id or nearby text).
 * Sensitive questions are only ever answered from the user's saved answers;
 * identity numbers and signatures are never filled.
 */

/** A profile value, or a value derived from one. */
export type ProfileKey = AutofillKey | 'phoneCode' | 'skills' | 'languages' | 'certifications';

export type QuestionCategory = 'contact' | 'eligibility' | 'sponsorship' | 'salary' | 'availability' | 'relocation' | 'employment' | 'demographics' | 'experience' | 'documents' | 'consent' | 'custom';

/** Never filled, even with a saved answer: identity numbers, secrets, CAPTCHAs. */
export const NEVER_RE =
  /password|captcha|\bssn\b|social security|\bsin\b|social insurance|national (id|insurance)|passport|date of birth|birth ?date|\bdob\b|credit card|card number|\bcvv\b|bank account|routing number|driver'?s? licen[cs]e|licen[cs]e number|health (card|insurance number)|\btax (id|number)\b|\bitin\b|maiden name/;

/** Signing is the applicant's act: Job Copilot never types a signature, even if it is just the name. */
export const SIGNATURE_RE = /signature|\be ?sign|\bsign (here|below|your name)|\binitials\b|type your (full |legal )?name (to|as) (sign|confirm|acknowledge|attest)|electronic(ally)? sign/;

/** Details of someone else (a reference, an emergency contact, a referrer): never the applicant's own. */
export const OTHER_PERSON_RE =
  /\breferences?\b|\breferee|emergency|next of kin|referr(er|ed by)|referral('?s)? (name|e ?mail|contact|phone)|recommender|\b(supervisor|manager|spouse|parent|guardian|contact person)'?s? (name|e ?mail|phone|number|contact)|who referred you/;

export const RESUME_RE = /resume|résumé|\bcv\b|curriculum/;
export const COVER_RE = /cover ?letter|motivation letter|letter of (interest|motivation)/;
export const CONSENT_RE = /\bi (agree|acknowledge|consent|certify|confirm|understand|accept|attest)|privacy (policy|notice)|terms (of|and)|data (processing|protection)|gdpr/;
export const COUNTRY_CODE_RE = /country (phone |calling |dial(ing)? )?code|phone (country )?code|dial(ing)? code|calling code/;

/** Profile values. Ordered: on equal evidence the earlier rule wins. */
export const PROFILE_RULES: Array<{ key: ProfileKey; re: RegExp; not?: RegExp }> = [
  { key: 'linkedin', re: /linked ?in/ },
  { key: 'github', re: /git ?hub/ },
  { key: 'website', re: /portfolio|website|web site|personal (site|url|page)|home ?page|\bblog\b|^urls? other$|^url$/, not: /linked ?in|git ?hub|twitter|facebook|instagram|company/ },
  { key: 'email', re: /e ?mail/ },
  { key: 'phoneCode', re: COUNTRY_CODE_RE },
  // Not Workday's "Country Phone Code" picker: typing the number there also used up the phone value before the real phone box.
  { key: 'phone', re: /phone|mobile|\btel\b|telephone|\bcell\b/, not: /type|country|(dial(ing)?|calling|phone|area) code|extension|\bext\b/ },
  { key: 'firstName', re: /\b(first|given|fore) ?name\b|firstname|givenname|^fname$/ },
  { key: 'lastName', re: /\b(last|family|sur) ?name\b|lastname|surname|familyname|^lname$/ },
  { key: 'fullName', re: /^(full |your |legal |candidate |applicant )?name$|\bfull ?name\b|\byour name\b|^system ?field name$/ },
  { key: 'currentCompany', re: /\b(current|present|most recent|latest) (company|employer|organi[sz]ation)\b|^(company|employer|organi[sz]ation|org)( name)?$/ },
  { key: 'currentTitle', re: /\b(current|present|most recent|latest) (job )?(title|role|position)\b|^(current )?job title$|^headline$/ },
  { key: 'postalCode', re: /postal|\bzip\b|zip ?code|post ?code|postcode/ },
  { key: 'location', re: /location|where (are you|do you) (located|live|based)|city.*(state|country|province)|current (city|residence)/, not: /street|line ?\d|zip|postal|willing|prefer|relocat|job location|work location|office/ },
  { key: 'address', re: /street|address ?(line)? ?1\b|^address$|(mailing|home|residential|street|current|postal) address/, not: /e ?mail|line ?2|web|url|ip address/ },
  { key: 'city', re: /^city$|\bcity\b|\btown\b/, not: /citizen/ },
  { key: 'state', re: /\bstate\b|province|^region$|territor/, not: /united states|statement|state (your|why|how|the|any|if)|status|\bstated\b/ },
  { key: 'country', re: /\bcountry\b|nation of residence/, not: /code|phone|dial|calling|citizen|authori[sz]|eligib|origin|birth|other than|which countr(y|ies) (are|have)/ },
  { key: 'school', re: /^(school|university|college|institution)( name)?$|school name|\bschool\b|\buniversity\b/, not: /high school|degree|year|date/ },
  { key: 'degree', re: /\bdegree\b/, not: /year|date|level of|require/ },
  { key: 'discipline', re: /discipline|\bmajor\b|field of study|area of study/ },
  { key: 'skills', re: /^(key |technical |relevant |core )?skills?( set)?$|^list (your )?(key |technical )?skills/, not: /years|experience with|rate|level/ },
  { key: 'languages', re: /^languages?( spoken| you speak)?$|what languages do you speak/, not: /programming/ },
  { key: 'certifications', re: /^(licenses? (and|&) )?certifications?$|certifications? (you hold|held)/ },
];

/** Screening questions. Matched before profile rules; answered only from the user's saved answers. */
export const STANDARD_RULES: Array<{ key: StandardQuestion; re: RegExp }> = [
  { key: 'sponsorship', re: /sponsor|visa (status|support)|h ?1 ?b/ },
  { key: 'workAuthorized', re: /authori[sz]ed to work|authori[sz]ation to work|work authori[sz]ation|legally (allowed|able|eligible|permitted|entitled) to work|right to work|eligib\w* to work/ },
  { key: 'relocate', re: /relocat/ },
  { key: 'over18', re: /\b18\b.*(years|older|age)|eighteen|at least 18|legal (working )?age/ },
  { key: 'salary', re: /salary|compensation|pay (expectation|range|requirement)|desired pay|expected (pay|rate)|hourly rate/ },
  { key: 'startDate', re: /start date|available to start|earliest (start|date|availability)|notice period|when (can|could) you start|date available/ },
  // Total experience only: "years of Python experience" is a skill question, drafted in the side panel.
  { key: 'yearsExperience', re: /\byears of (professional |relevant |work |industry |total )?experience\b|how many years (of )?(professional |relevant |work |industry |total )?(experience|have you worked)/ },
  { key: 'hearAbout', re: /how did you (hear|find|learn|discover)|where did you (hear|find|see|learn)|referral source|source of (application|referral)/ },
  { key: 'hispanic', re: /hispanic|latin[oax]/ },
  { key: 'race', re: /\brace\b|ethnic/ },
  { key: 'gender', re: /gender|\bsex\b/ },
  { key: 'veteran', re: /veteran|military service/ },
  { key: 'disability', re: /disab/ },
  { key: 'pronouns', re: /pronoun/ },
];

export const AUTOCOMPLETE: Record<string, ProfileKey> = {
  'given-name': 'firstName',
  'family-name': 'lastName',
  name: 'fullName',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  'tel-country-code': 'phoneCode',
  organization: 'currentCompany',
  'organization-title': 'currentTitle',
  url: 'website',
  'street-address': 'address',
  'address-line1': 'address',
  'address-level2': 'city',
  'address-level1': 'state',
  'postal-code': 'postalCode',
  country: 'country',
  'country-name': 'country',
};

const STANDARD_CATEGORY: Record<StandardQuestion, QuestionCategory> = {
  sponsorship: 'sponsorship',
  workAuthorized: 'eligibility',
  over18: 'eligibility',
  relocate: 'relocation',
  salary: 'salary',
  startDate: 'availability',
  yearsExperience: 'experience',
  hearAbout: 'custom',
  hispanic: 'demographics',
  race: 'demographics',
  gender: 'demographics',
  veteran: 'demographics',
  disability: 'demographics',
  pronouns: 'demographics',
};

export type Classification =
  | { type: 'never' }
  | { type: 'signature' }
  | { type: 'file'; doc: 'resume' | 'cover' | 'other' }
  | { type: 'consent' }
  | { type: 'coverText' }
  | { type: 'standard'; key: StandardQuestion }
  | { type: 'profile'; key: ProfileKey; confidence: number }
  /** "Do you have experience with Kubernetes?": Yes only when the skill is on the résumé. */
  | { type: 'skill'; skill: string }
  /** "Do you speak French?": Yes only when the language is on the résumé. */
  | { type: 'language'; language: string }
  | { type: 'other' };

/** The strongest evidence for a pattern among a field's descriptors (0 when none). */
function evidence(dw: Descriptor[], re: RegExp, not?: RegExp): number {
  let best = 0;
  for (const d of dw) if (d.w > best && re.test(d.text) && !not?.test(d.text)) best = d.w;
  return best;
}

/** Below this, a match rests only on hints (help text): the user is asked instead. */
const MIN_EVIDENCE = 0.5;

const SKILL_Q_RE = /^(?:do|have) you (?:have )?(?:any )?(?:hands on |professional |prior |previous |working |practical |direct )?(?:experience|knowledge|familiarity|proficiency) (?:with|in|using|of) ([a-z0-9+#. ]{1,40})$/;
const LANGUAGE_Q_RE = /^(?:do|can) you (?:speak|read and write|communicate in)(?: fluently in)? ([a-z]+)(?: fluently| proficiently)?$/;

export function classifyQuestion(q: Pick<Question, 'kind' | 'dw' | 'ds' | 'el' | 'label' | 'section'>): Classification {
  const dw = q.dw.length ? q.dw : q.ds.map((text) => ({ text, w: 1 }));
  if (evidence(dw, NEVER_RE) >= MIN_EVIDENCE) return { type: 'never' };
  if (q.kind === 'file') {
    if (evidence(dw, COVER_RE) >= 0.3) return { type: 'file', doc: 'cover' };
    if (evidence(dw, RESUME_RE) >= 0.3 && !(evidence(dw, OTHER_DOC_RE) > evidence(dw, RESUME_RE))) return { type: 'file', doc: 'resume' };
    return { type: 'file', doc: 'other' };
  }
  if (q.kind !== 'checkbox' && q.kind !== 'radio' && q.kind !== 'buttons' && evidence(dw, SIGNATURE_RE) >= MIN_EVIDENCE) return { type: 'signature' };
  if (q.kind === 'checkbox' && evidence(dw, CONSENT_RE) >= MIN_EVIDENCE) return { type: 'consent' };
  if ((q.kind === 'textarea' || q.kind === 'text' || q.kind === 'editable') && evidence(dw, COVER_RE) >= MIN_EVIDENCE) return { type: 'coverText' };
  let std: { key: StandardQuestion; w: number } | null = null;
  for (const r of STANDARD_RULES) {
    const w = evidence(dw, r.re);
    if (w >= MIN_EVIDENCE && (!std || w > std.w)) std = { key: r.key, w };
  }
  if (std) return { type: 'standard', key: std.key };
  const label = normalize(q.label);
  const skill = SKILL_Q_RE.exec(label);
  if (skill && !/\d|\byears?\b|\band\b|\bor\b/.test(skill[1]!)) return { type: 'skill', skill: skill[1]!.trim() };
  const lang = LANGUAGE_Q_RE.exec(label);
  if (lang) return { type: 'language', language: lang[1]! };
  const el = q.el;
  const auto = AUTOCOMPLETE[(el.getAttribute('autocomplete') ?? '').trim().toLowerCase().split(/\s+/).pop() ?? ''];
  let key: { key: ProfileKey; w: number } | null = auto ? { key: auto, w: 1 } : null;
  const type = (el as HTMLInputElement).type?.toLowerCase();
  if (!key && type === 'email') key = { key: 'email', w: 1 };
  if (!key && type === 'tel' && evidence(dw, COUNTRY_CODE_RE) < MIN_EVIDENCE) key = { key: 'phone', w: 1 };
  if (!key) {
    for (const r of PROFILE_RULES) {
      const w = evidence(dw, r.re, r.not);
      if (w >= MIN_EVIDENCE && (!key || w > key.w)) key = { key: r.key, w };
    }
  }
  if (!key) return { type: 'other' };
  // A name or email under "References" or "Emergency contact" belongs to someone else.
  if (OTHER_PERSON_RE.test(normalize(q.section)) || evidence(dw, OTHER_PERSON_RE) >= MIN_EVIDENCE) return { type: 'other' };
  return { type: 'profile', key: key.key, confidence: key.w };
}

/** Kept for callers that only need the profile key of a text field. */
export function classifyField(el: HTMLInputElement | HTMLTextAreaElement, ds: Descriptor[]): AutofillKey | StandardQuestion | 'never' | null {
  const c = classifyQuestion({ kind: 'text', dw: ds, ds: ds.map((d) => d.text), el, label: ds[0]?.text ?? '', section: '' });
  if (c.type === 'never') return 'never';
  if (c.type === 'standard') return c.key;
  if (c.type === 'profile' && c.key !== 'phoneCode' && c.key !== 'skills' && c.key !== 'languages' && c.key !== 'certifications') return c.key;
  return null;
}

const CATEGORY_RULES: Array<[QuestionCategory, RegExp]> = [
  ['sponsorship', /sponsor|visa/],
  ['eligibility', /authori[sz]|eligib|citizen|clearance|background check|criminal|convict|non ?compete|legally|right to work|\b18\b/],
  ['salary', /salary|compensation|pay|rate|wage/],
  ['availability', /start|notice|availab|when can you/],
  ['relocation', /relocat|commut|on ?site|hybrid|remote|travel|office/],
  ['employment', /full ?time|part ?time|contract|employment type|shift|hours|weekend|overtime/],
  ['demographics', /gender|race|ethnic|hispanic|veteran|disab|pronoun|orientation|lgbt|transgender/],
  ['experience', /experience|years|proficien|skill|language|certif|degree|education/],
  ['consent', /agree|acknowledge|consent|certify|privacy|terms|signature|initials/],
];

/** A heading for the side panel's question list. */
export function categoryOf(q: Pick<Question, 'kind' | 'dw' | 'ds' | 'el' | 'label' | 'section'>, c = classifyQuestion(q)): QuestionCategory {
  if (c.type === 'standard') return STANDARD_CATEGORY[c.key];
  if (c.type === 'file' || c.type === 'coverText') return 'documents';
  if (c.type === 'consent' || c.type === 'signature') return 'consent';
  if (c.type === 'profile') return 'contact';
  if (c.type === 'skill' || c.type === 'language') return 'experience';
  const t = normalize(q.label);
  for (const [cat, re] of CATEGORY_RULES) if (re.test(t)) return cat;
  return 'custom';
}
