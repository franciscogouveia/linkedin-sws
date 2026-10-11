export interface Investor {
  name: string;
  role: string;
  slug: string;
}

export type ProfileStatus = 'new' | 'working' | 'written' | 'failed';
export type MessageStatus = 'new' | 'sent' | 'failed' | 'dryrun';
export interface ProfileRow extends Investor {
  id: number;
  status: ProfileStatus;
  failure: string;
}
export interface MessageRow extends Investor {
  id: number;
  profile_id: number;
  subject: string;
  message: string;
  status: MessageStatus;
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

export interface MessageDraft {
  body: string;
  subject?: string;
}
export interface MessageComposer {
  kind: 'chat' | 'inmail';
  fill(draft: MessageDraft): Promise<void>;
  /** Persist the attempt immediately before the irreversible click. */
  send?(beforeClick: () => void): Promise<void>;
}
export interface LinkedInMessenger {
  openComposer(recipient: Investor): Promise<MessageComposer>;
}

export interface PitchWriter {
  writeSubject(
    profile: Profile,
    pitch: string,
    body: string,
    context?: OutreachContext,
  ): Promise<string>;
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

export interface ProfileStore {
  has(slug: string): boolean;
  append(investor: Investor, failure?: string): boolean;
  next(excluded: number[]): ProfileRow | undefined;
  retry(id: number): void;
  counts(): Record<ProfileStatus, number>;
}
export interface MessagingStore {
  save(profileId: number, draft: Required<MessageDraft>): void;
  next(excluded: number[]): MessageRow | undefined;
  finish(
    id: number,
    status: 'failed' | 'dryrun' | 'sent',
    failure?: string,
  ): void;
  failSend(id: number, reason: string): void;
  counts(): Record<MessageStatus, number>;
}

export interface TextRequest {
  instructions: string;
  input: string;
  operation: 'classification' | 'message generation' | 'subject generation';
  redactions: string[];
  format?: { name: string; schema: Record<string, unknown> };
}

export interface TextGenerator {
  request(request: TextRequest): Promise<string>;
}

export const SEND_UNCERTAIN_FAILURE =
  'send outcome uncertain; verify the LinkedIn conversation manually before retrying';
