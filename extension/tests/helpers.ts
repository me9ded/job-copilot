import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Profile, type ExtractedJob } from '../src/lib/types';

export function fixture(name: string): string {
  return readFileSync(resolve(__dirname, 'fixtures', name), 'utf8');
}

export function loadDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

export function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return Profile.parse({
    basics: {
      name: 'Sam Rivera',
      headline: 'Backend Software Engineer',
      email: 'sam@example.com',
      summary: 'Backend engineer focused on Python services and cloud infrastructure.',
    },
    skills: ['Python', 'PostgreSQL', 'Docker', 'AWS', 'TypeScript', 'React', 'MuleSoft'],
    experience: [
      {
        id: 'e1',
        title: 'Software Engineer',
        company: 'Globex',
        start: '2019-01',
        end: '2021-06',
        bullets: ['Built REST APIs in Python and Flask serving 2M requests/day', 'Migrated batch jobs to Kubernetes'],
      },
      {
        id: 'e2',
        title: 'Senior Software Engineer',
        company: 'Initech',
        start: '2021-07',
        end: 'present',
        bullets: ['Led migration of services to AWS with Terraform', 'Mentored 3 junior engineers', 'Responsible for on-call rotation'],
      },
    ],
    education: [{ id: 'ed1', institution: 'University of Waterloo', degree: 'Bachelor of Science', field: 'Computer Science' }],
    projects: [{ id: 'p1', name: 'Queue Monitor', description: 'Kafka lag dashboard', bullets: ['Built with Go and Grafana'], skills: [] }],
    preferences: { locations: ['Toronto'], workArrangements: ['hybrid', 'remote'], seniority: ['senior'] },
    ...overrides,
  });
}

export function makeJob(overrides: Partial<ExtractedJob> = {}): ExtractedJob {
  return {
    title: 'Senior Backend Engineer',
    company: 'Acme',
    location: 'Toronto, ON',
    workArrangement: 'hybrid',
    descriptionText: 'Requirements\n• 5+ years of experience\n• Python and PostgreSQL\n• Docker\nNice to have\n• Kafka',
    responsibilities: [],
    requiredQualifications: ['5+ years of experience', 'Python and PostgreSQL', 'Docker'],
    preferredQualifications: ['Kafka'],
    url: 'https://example.com/jobs/1',
    adapter: 'test',
    completeness: 0.8,
    missingFields: [],
    warnings: [],
    ...overrides,
  };
}
