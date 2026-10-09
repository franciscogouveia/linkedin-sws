export interface Investor {
  name: string;
  role: string;
  slug: string;
}

export type QueueStatus = 'new' | 'working' | 'sent' | 'failed' | 'dryrun';

export interface QueueRow extends Investor {
  id: number;
  status: QueueStatus;
  failure: string;
}

export interface Profile {
  slug: string;
  name: string;
  text: string;
  truncated: boolean;
  sections?: { header: string; about: string; experience: string };
  searchRole?: string;
}

export interface SearchCriteria {
  keywords: string;
  max_results: number;
  max_pages: number;
}

export interface LinkedInReader {
  search(
    criteria: SearchCriteria,
    onResult: (investor: Investor) => void,
  ): Promise<number>;
  readProfile(slug: string, expectedName?: string): Promise<Profile | null>;
}

export interface Assessment {
  decision: 'investor' | 'not_investor' | 'uncertain';
  evidence: string;
  reason: string;
}

export interface PitchWriter {
  classify(profile: Profile): Promise<Assessment>;
  write(
    profile: Profile,
    pitch: string,
    context?: OutreachContext,
  ): Promise<string>;
}

export interface OutreachContext {
  founder_name?: string | undefined;
  founder_role?: string | undefined;
  business_name?: string | undefined;
  industry?: string | undefined;
  funding_stage?: string | undefined;
  funding_ask?: string | undefined;
  website?: string | undefined;
}

export interface QueueStore {
  append(investor: Investor): boolean;
  next(): QueueRow | undefined;
  finish(id: number, status: 'failed' | 'dryrun', failure?: string): void;
  counts(): Record<QueueStatus, number>;
}

export interface TextRequest {
  instructions: string;
  input: string;
  operation: 'classification' | 'message generation';
  redactions: string[];
  format?: { name: string; schema: Record<string, unknown> };
}

export interface TextGenerator {
  request(request: TextRequest): Promise<string>;
}
