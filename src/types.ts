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
  readProfile(slug: string): Promise<Profile | null>;
}

export interface Assessment {
  decision: 'investor' | 'not_investor' | 'uncertain';
  evidence: string;
  reason: string;
}

export interface PitchWriter {
  classify(profile: Profile): Promise<Assessment>;
  write(profile: Profile, pitch: string): Promise<string>;
}
