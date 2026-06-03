// ─── Instagram / Meta ────────────────────────────────────────────────────────

export interface InstagramProfile {
  id: string;
  username: string;
  name: string;
  biography: string;
  profilePictureUrl: string;
  followersCount: number;
  mediaCount: number;
  website?: string;
}

export interface InstagramPost {
  id: string;
  caption?: string;
  mediaType: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM' | 'REEL';
  mediaUrl?: string;
  thumbnailUrl?: string;
  permalink?: string;
  timestamp: string;
  likeCount?: number;
  commentsCount?: number;
}

// ─── Analyzed content (caption + optional transcript) ────────────────────────

export interface TranscriptSegment {
  start: number; // seconds
  end: number;
  text: string;
}

export interface PostContent {
  postId: string;
  caption: string;
  transcript: string | null;
  transcriptSegments?: TranscriptSegment[];
  timestamp: string;
  mediaType: string;
  thumbnailUrl?: string;
  permalink?: string;
  transcriptionFailed?: boolean;
}

// ─── Compliance rule types ────────────────────────────────────────────────────

export enum RuleStatus {
  PASS = 'PASS',
  WARN = 'WARN',
  FAIL = 'FAIL',
}

export enum OverallVerdict {
  COMPLIANT = 'COMPLIANT',
  REVIEW_REQUIRED = 'REVIEW_REQUIRED',
  NON_COMPLIANT = 'NON_COMPLIANT',
}

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface RuleFlag {
  postId: string;
  excerpt: string;
  explanation: string;
  severity: Severity;
  timestampSeconds?: number; // populated when excerpt is matched to a video segment
}

export interface RuleResult {
  ruleId: string;
  ruleName: string;
  description: string;
  status: RuleStatus;
  flags: RuleFlag[];
}

// ─── SEBI ─────────────────────────────────────────────────────────────────────

export enum SEBIRuleId {
  UNREG_INVESTMENT_ADVICE = 'SEBI_UNREG_INVESTMENT_ADVICE',
  GUARANTEED_RETURNS = 'SEBI_GUARANTEED_RETURNS',
  MISSING_REG_DISCLOSURE = 'SEBI_MISSING_REG_DISCLOSURE',
  UNDISCLOSED_PAID_PROMO = 'SEBI_UNDISCLOSED_PAID_PROMO',
  FRAUDULENT_COURSE = 'SEBI_FRAUDULENT_COURSE',
}

export interface SEBIComplianceResult {
  rules: Record<SEBIRuleId, RuleResult>;
  hasSEBIRegistration: boolean;
  sebiRegistrationNumber?: string;
  score: number;
}

// ─── Brand Safety ─────────────────────────────────────────────────────────────

export enum BrandSafetyRuleId {
  PROFANITY = 'BRAND_PROFANITY',
  HATE_SPEECH = 'BRAND_HATE_SPEECH',
  VIOLENCE = 'BRAND_VIOLENCE',
  PII_DISCLOSURE = 'BRAND_PII_DISCLOSURE',
  COMPETITOR_MENTION = 'BRAND_COMPETITOR_MENTION',
}

export interface BrandSafetyResult {
  rules: Record<BrandSafetyRuleId, RuleResult>;
  score: number;
}

// ─── Final Report ─────────────────────────────────────────────────────────────

export interface PostMedia {
  thumbnail?: string;
  permalink?: string;
}

export interface ComplianceReport {
  reportId: string;
  createdAt: string;
  creator: InstagramProfile;
  postsAnalyzed: number;
  postsTranscribed: number;
  postMedia: Record<string, PostMedia>;
  sebiCompliance: SEBIComplianceResult;
  brandSafety: BrandSafetyResult;
  overallScore: number;
  verdict: OverallVerdict;
  summaryNotes: string[];
}

// ─── LLM structured output schemas (Zod-validated) ───────────────────────────

export interface PostLLMFlag {
  rule_id: string;
  is_flagged: boolean;
  severity: Severity;
  excerpt: string;
  explanation: string;
}

export interface PostLLMAnalysis {
  sebi_violations: PostLLMFlag[];
  brand_safety_issues: PostLLMFlag[];
}
