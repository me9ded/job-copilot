import type { ApplicationStatus, WorkArrangement } from '../lib/types';

export const STATUS_LABEL: Record<ApplicationStatus, string> = {
  discovered: 'Discovered',
  saved: 'Saved',
  to_review: 'To review',
  preparing: 'Preparing',
  ready: 'Ready to apply',
  applied: 'Applied',
  interviewing: 'Interviewing',
  offer: 'Offer',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

export const STATUS_TONE: Record<ApplicationStatus, 'neutral' | 'accent' | 'good' | 'warn' | 'bad'> = {
  discovered: 'neutral',
  saved: 'neutral',
  to_review: 'neutral',
  preparing: 'accent',
  ready: 'accent',
  applied: 'accent',
  interviewing: 'warn',
  offer: 'good',
  rejected: 'bad',
  withdrawn: 'neutral',
};

export const ARRANGEMENT_LABEL: Record<WorkArrangement, string> = {
  remote: 'Remote',
  hybrid: 'Hybrid',
  onsite: 'On-site',
  unknown: 'Arrangement not stated',
};

export const FIELD_LABEL: Record<string, string> = {
  title: 'job title',
  company: 'company',
  description: 'full description',
  location: 'location',
  requirements: 'requirements section',
  employmentType: 'employment type',
  salary: 'salary',
  datePosted: 'posting date',
};
