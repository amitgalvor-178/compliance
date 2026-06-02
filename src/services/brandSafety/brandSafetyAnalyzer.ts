/**
 * Brand safety analyzer.
 *
 * Uses the same two-tier approach as galvor-tech/workflows:
 *  1. OpenAI Moderation API (cheap, fast) — profanity, hate speech, violence
 *  2. Regex — PII detection (phone, Aadhaar, PAN)
 *  3. Keyword matching — competitor brand mentions
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';
import {
  BrandSafetyRuleId,
  RuleStatus,
  type PostContent,
  type BrandSafetyResult,
  type RuleResult,
  type RuleFlag,
} from '../../types/index.js';

dotenv.config();

// ─── PII patterns (Indian context) ───────────────────────────────────────────

const PII_PATTERNS = [
  { pattern: /\b[6-9]\d{9}\b/, label: 'Phone number', severity: 'high' as const },
  { pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/, label: 'Aadhaar-like number', severity: 'high' as const },
  {
    pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/,
    label: 'PAN card number',
    severity: 'high' as const,
  },
  {
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
    label: 'Email address',
    severity: 'medium' as const,
  },
];

// ─── Competitor detection ─────────────────────────────────────────────────────

function getCompetitorBrands(): string[] {
  const env = process.env.COMPETITOR_BRANDS || '';
  return env
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean);
}

function checkCompetitorMentions(text: string, postId: string): RuleFlag[] {
  const competitors = getCompetitorBrands();
  if (competitors.length === 0) return [];

  const flags: RuleFlag[] = [];
  for (const brand of competitors) {
    const regex = new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const match = text.match(regex);
    if (match) {
      const idx = text.indexOf(match[0]);
      const excerpt = text.slice(Math.max(0, idx - 40), idx + 80);
      flags.push({
        postId,
        excerpt: excerpt.trim(),
        explanation: `Competitor brand "${brand}" mentioned`,
        severity: 'medium',
      });
    }
  }
  return flags;
}

// ─── PII check ────────────────────────────────────────────────────────────────

function checkPII(text: string, postId: string): RuleFlag[] {
  const flags: RuleFlag[] = [];
  for (const { pattern, label, severity } of PII_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      flags.push({
        postId,
        excerpt: match[0],
        explanation: `${label} detected in post content`,
        severity,
      });
    }
  }
  return flags;
}

// ─── OpenAI Moderation (reused from workflows BrandSafetyService pattern) ────

async function runModeration(
  text: string,
): Promise<OpenAI.Moderations.Moderation | null> {
  if (!text.trim()) return null;

  const client = new OpenAI({
    apiKey: process.env.OPENAI_MODERATION_API_KEY || process.env.OPENAI_API_KEY,
  });

  try {
    const result = await client.moderations.create({ input: text });
    return result.results[0] ?? null;
  } catch (err) {
    console.error('Moderation API error:', err);
    return null;
  }
}

function moderationToFlags(
  modResult: OpenAI.Moderations.Moderation,
  postId: string,
): { profanity: RuleFlag[]; hateSpeech: RuleFlag[]; violence: RuleFlag[] } {
  const out = { profanity: [] as RuleFlag[], hateSpeech: [] as RuleFlag[], violence: [] as RuleFlag[] };
  if (!modResult.flagged) return out;

  const scores = modResult.category_scores as Record<string, number>;
  const categories = modResult.categories as Record<string, boolean>;

  if (categories['sexual'] || scores['sexual'] > 0.5) {
    out.profanity.push({
      postId,
      excerpt: '',
      explanation: `OpenAI Moderation flagged sexual/explicit content (score: ${(scores['sexual'] * 100).toFixed(0)}%)`,
      severity: scores['sexual'] > 0.8 ? 'critical' : 'high',
    });
  }

  if (categories['hate'] || scores['hate'] > 0.4) {
    out.hateSpeech.push({
      postId,
      excerpt: '',
      explanation: `OpenAI Moderation flagged hate/discriminatory content (score: ${(scores['hate'] * 100).toFixed(0)}%)`,
      severity: scores['hate'] > 0.7 ? 'critical' : 'high',
    });
  }

  if (categories['violence'] || scores['violence'] > 0.4) {
    out.violence.push({
      postId,
      excerpt: '',
      explanation: `OpenAI Moderation flagged violent content (score: ${(scores['violence'] * 100).toFixed(0)}%)`,
      severity: scores['violence'] > 0.7 ? 'critical' : 'high',
    });
  }

  if (categories['harassment'] || scores['harassment'] > 0.5) {
    out.profanity.push({
      postId,
      excerpt: '',
      explanation: `OpenAI Moderation flagged harassment/profanity (score: ${(scores['harassment'] * 100).toFixed(0)}%)`,
      severity: 'high',
    });
  }

  return out;
}

// ─── Rule aggregator ──────────────────────────────────────────────────────────

const BRAND_RULE_DEFS: Record<BrandSafetyRuleId, { name: string; description: string }> = {
  [BrandSafetyRuleId.PROFANITY]: {
    name: 'Profanity / Explicit Content',
    description: 'Vulgar language, sexual or explicit content in captions or video audio',
  },
  [BrandSafetyRuleId.HATE_SPEECH]: {
    name: 'Hate Speech / Discrimination',
    description: 'Content targeting individuals or groups based on protected characteristics',
  },
  [BrandSafetyRuleId.VIOLENCE]: {
    name: 'Violence / Graphic Content',
    description: 'Depictions or glorification of violence, gore, or self-harm',
  },
  [BrandSafetyRuleId.PII_DISCLOSURE]: {
    name: 'Personal Information Disclosure',
    description: 'Exposure of personal data such as phone numbers, Aadhaar, PAN, or email addresses',
  },
  [BrandSafetyRuleId.COMPETITOR_MENTION]: {
    name: 'Competitor Brand Mention',
    description: 'Direct mention of competitor brands in content',
  },
};

function flagsToRuleResult(
  id: BrandSafetyRuleId,
  flags: RuleFlag[],
): RuleResult {
  const def = BRAND_RULE_DEFS[id];
  let status: RuleStatus;

  if (flags.length === 0) {
    status = RuleStatus.PASS;
  } else if (flags.some((f) => f.severity === 'critical' || f.severity === 'high')) {
    status = RuleStatus.FAIL;
  } else {
    status = RuleStatus.WARN;
  }

  return {
    ruleId: id,
    ruleName: def.name,
    description: def.description,
    status,
    flags,
  };
}

function calculateBrandSafetyScore(rules: Record<BrandSafetyRuleId, RuleResult>): number {
  const points = Object.values(rules).map((r) => {
    if (r.status === RuleStatus.PASS) return 100;
    if (r.status === RuleStatus.WARN) return 60;
    return 0;
  });
  return Math.round(points.reduce((a, b) => a + b, 0) / points.length);
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function analyzeBrandSafety(posts: PostContent[]): Promise<BrandSafetyResult> {
  const allFlags = {
    [BrandSafetyRuleId.PROFANITY]: [] as RuleFlag[],
    [BrandSafetyRuleId.HATE_SPEECH]: [] as RuleFlag[],
    [BrandSafetyRuleId.VIOLENCE]: [] as RuleFlag[],
    [BrandSafetyRuleId.PII_DISCLOSURE]: [] as RuleFlag[],
    [BrandSafetyRuleId.COMPETITOR_MENTION]: [] as RuleFlag[],
  };

  await Promise.allSettled(
    posts.map(async (post) => {
      const fullText = [post.caption, post.transcript].filter(Boolean).join('\n\n');
      if (!fullText.trim()) return;

      // Run all checks in parallel per post
      const [modResult] = await Promise.all([runModeration(fullText)]);

      if (modResult) {
        const { profanity, hateSpeech, violence } = moderationToFlags(modResult, post.postId);
        allFlags[BrandSafetyRuleId.PROFANITY].push(...profanity);
        allFlags[BrandSafetyRuleId.HATE_SPEECH].push(...hateSpeech);
        allFlags[BrandSafetyRuleId.VIOLENCE].push(...violence);
      }

      allFlags[BrandSafetyRuleId.PII_DISCLOSURE].push(...checkPII(fullText, post.postId));
      allFlags[BrandSafetyRuleId.COMPETITOR_MENTION].push(
        ...checkCompetitorMentions(fullText, post.postId),
      );
    }),
  );

  const rules = {
    [BrandSafetyRuleId.PROFANITY]: flagsToRuleResult(BrandSafetyRuleId.PROFANITY, allFlags[BrandSafetyRuleId.PROFANITY]),
    [BrandSafetyRuleId.HATE_SPEECH]: flagsToRuleResult(BrandSafetyRuleId.HATE_SPEECH, allFlags[BrandSafetyRuleId.HATE_SPEECH]),
    [BrandSafetyRuleId.VIOLENCE]: flagsToRuleResult(BrandSafetyRuleId.VIOLENCE, allFlags[BrandSafetyRuleId.VIOLENCE]),
    [BrandSafetyRuleId.PII_DISCLOSURE]: flagsToRuleResult(BrandSafetyRuleId.PII_DISCLOSURE, allFlags[BrandSafetyRuleId.PII_DISCLOSURE]),
    [BrandSafetyRuleId.COMPETITOR_MENTION]: flagsToRuleResult(BrandSafetyRuleId.COMPETITOR_MENTION, allFlags[BrandSafetyRuleId.COMPETITOR_MENTION]),
  } as Record<BrandSafetyRuleId, RuleResult>;

  return { rules, score: calculateBrandSafetyScore(rules) };
}
