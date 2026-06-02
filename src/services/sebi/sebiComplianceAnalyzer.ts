/**
 * SEBI compliance analyzer.
 *
 * Uses the same LLM structured-output + Zod pattern as
 * galvor-tech/workflows src/services/caption-analysis.ts — single LLM call
 * per post that checks all 4 LLM-evaluated SEBI rules at once.
 * MISSING_REG_DISCLOSURE is handled via regex on bio + transcript start.
 */

import OpenAI from 'openai';
import { z } from 'zod';
import { langfuse } from '../../config/langfuse.js';
import { analysisLimiter } from '../../config/ratelimiter.js';
import {
  SEBIRuleId,
  RuleStatus,
  OverallVerdict,
  type PostContent,
  type InstagramProfile,
  type SEBIComplianceResult,
  type RuleResult,
  type RuleFlag,
} from '../../types/index.js';
import {
  SEBI_RULES,
  CRITICAL_SEBI_RULE_IDS,
  extractSEBIRegistration,
} from './sebiRules.js';

// ─── Zod schema for LLM output ────────────────────────────────────────────────

const FlagSchema = z.object({
  rule_id: z.string(),
  is_flagged: z.boolean(),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  excerpt: z.string(),
  explanation: z.string(),
});

const PostAnalysisSchema = z.object({
  violations: z.array(FlagSchema),
});

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  const ruleDescriptions = SEBI_RULES.filter(
    (r) => r.id !== SEBIRuleId.MISSING_REG_DISCLOSURE,
  )
    .map(
      (r) => `### ${r.id}\nName: ${r.name}\nSource: ${r.source}\n${r.llmGuidance}`,
    )
    .join('\n\n');

  return `You are a SEBI (Securities and Exchange Board of India) compliance analyst.
Your task is to analyze Instagram post content (caption + video transcript) and identify violations of SEBI regulations.

Rules to check:
${ruleDescriptions}

For each rule, return an entry in "violations" array with:
- rule_id: the rule identifier
- is_flagged: true if a violation is detected
- severity: how serious (critical/high/medium/low)
- excerpt: the exact problematic text (max 150 chars), empty string if not flagged
- explanation: brief reason for flagging (max 200 chars), empty string if not flagged

Return ALL rules in the violations array (even non-flagged ones with is_flagged: false).
Be precise — only flag genuine violations, not general financial discussion.`;
}

// Azure OpenAI client (reused from config)
let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) {
    const { AzureOpenAI } = require('openai');
    _openai = new AzureOpenAI({
      endpoint: process.env.AZURE_OPEN_AI_ENDPOINT!,
      apiKey: process.env.AZURE_OPEN_AI_KEY!,
      apiVersion: '2024-08-01-preview',
    });
  }
  return _openai!;
}

// ─── Per-post LLM analysis ────────────────────────────────────────────────────

async function analyzePostForSEBI(
  content: PostContent,
  openaiClient: OpenAI,
): Promise<RuleFlag[]> {
  const text = [
    content.caption ? `Caption: ${content.caption}` : '',
    content.transcript ? `Transcript: ${content.transcript}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  if (!text.trim()) return [];

  const ruleIds = SEBI_RULES.filter((r) => r.id !== SEBIRuleId.MISSING_REG_DISCLOSURE).map(
    (r) => r.id,
  );

  const response = await analysisLimiter.schedule(
    { id: `sebi-${content.postId}` },
    async () =>
      openaiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          {
            role: 'user',
            content: `Analyze this Instagram post content:\n\n${text}\n\nPost date: ${content.timestamp}`,
          },
        ],
        temperature: 0.1,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'sebi_analysis',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                violations: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      rule_id: { type: 'string', enum: ruleIds },
                      is_flagged: { type: 'boolean' },
                      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
                      excerpt: { type: 'string' },
                      explanation: { type: 'string' },
                    },
                    required: ['rule_id', 'is_flagged', 'severity', 'excerpt', 'explanation'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['violations'],
              additionalProperties: false,
            },
          },
        },
      }),
  );

  const raw = response.choices[0]?.message?.content;
  if (!raw) return [];

  const parsed = PostAnalysisSchema.parse(JSON.parse(raw));

  return parsed.violations
    .filter((v) => v.is_flagged)
    .map((v) => ({
      postId: content.postId,
      excerpt: v.excerpt,
      explanation: v.explanation,
      severity: v.severity,
      _ruleId: v.rule_id,
    })) as any;
}

// ─── Registration disclosure check ───────────────────────────────────────────

function checkRegistrationDisclosure(
  profile: InstagramProfile,
  posts: PostContent[],
): { hasSEBIReg: boolean; regNumber?: string; flags: RuleFlag[] } {
  const bioReg = extractSEBIRegistration(profile.biography);

  // Check if any post discusses financial/securities content
  const financialKeywords =
    /\b(stock|share|mutual fund|trading|invest|nifty|sensex|equity|portfolio|demat|broker|ipo|sebi)\b/i;

  const financialPosts = posts.filter(
    (p) =>
      financialKeywords.test(p.caption || '') || financialKeywords.test(p.transcript || ''),
  );

  if (financialPosts.length === 0) {
    // Creator doesn't post financial content — rule not applicable
    return { hasSEBIReg: !!bioReg, regNumber: bioReg ?? undefined, flags: [] };
  }

  const flags: RuleFlag[] = [];

  if (!bioReg) {
    flags.push({
      postId: 'PROFILE',
      excerpt: profile.biography.slice(0, 120),
      explanation:
        'Creator posts securities-related content but no SEBI registration number found in bio (required per SEBI Circular HO/79/2026 from May 1, 2026)',
      severity: 'high',
    });
  }

  // Check if financial video transcripts start with SEBI reg number
  const videoFinancialPosts = financialPosts.filter(
    (p) =>
      (p.mediaType === 'VIDEO' || p.mediaType === 'REEL') &&
      p.transcript &&
      p.transcript.length > 0,
  );

  for (const post of videoFinancialPosts.slice(0, 5)) {
    const first150 = (post.transcript || '').slice(0, 150);
    const transcriptReg = extractSEBIRegistration(first150);
    if (!transcriptReg) {
      flags.push({
        postId: post.postId,
        excerpt: first150,
        explanation:
          'Financial video content does not begin with SEBI registration number disclosure (required per SEBI Circular HO/79/2026)',
        severity: 'medium',
      });
    }
  }

  return { hasSEBIReg: !!bioReg, regNumber: bioReg ?? undefined, flags };
}

// ─── Rule aggregator ──────────────────────────────────────────────────────────

function buildRuleResults(
  allPostFlags: Array<{ postId: string; _ruleId: string } & RuleFlag>,
  regDisclosureFlags: RuleFlag[],
): Record<SEBIRuleId, RuleResult> {
  const results = {} as Record<SEBIRuleId, RuleResult>;

  for (const rule of SEBI_RULES) {
    const flags =
      rule.id === SEBIRuleId.MISSING_REG_DISCLOSURE
        ? regDisclosureFlags
        : allPostFlags
            .filter((f) => (f as any)._ruleId === rule.id)
            .map(({ postId, excerpt, explanation, severity }) => ({
              postId,
              excerpt,
              explanation,
              severity,
            }));

    let status: RuleStatus;
    if (flags.length === 0) {
      status = RuleStatus.PASS;
    } else if (flags.some((f) => f.severity === 'critical' || f.severity === 'high')) {
      status = RuleStatus.FAIL;
    } else {
      status = RuleStatus.WARN;
    }

    results[rule.id] = {
      ruleId: rule.id,
      ruleName: rule.name,
      description: rule.description,
      status,
      flags,
    };
  }

  return results;
}

function calculateSEBIScore(rules: Record<SEBIRuleId, RuleResult>): number {
  const points = Object.values(rules).map((r) => {
    if (r.status === RuleStatus.PASS) return 100;
    if (r.status === RuleStatus.WARN) return 60;
    return 0;
  });
  return Math.round(points.reduce((a, b) => a + b, 0) / points.length);
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function analyzeSEBICompliance(
  profile: InstagramProfile,
  posts: PostContent[],
): Promise<SEBIComplianceResult> {
  const trace = langfuse.trace({
    name: 'sebi-compliance-analysis',
    metadata: { handle: profile.username, postCount: posts.length },
  });

  try {
    const { AzureOpenAI } = await import('openai');
    const openaiClient = new AzureOpenAI({
      endpoint: process.env.AZURE_OPEN_AI_ENDPOINT!,
      apiKey: process.env.AZURE_OPEN_AI_KEY!,
      apiVersion: '2024-08-01-preview',
    }) as unknown as OpenAI;

    // Analyze all posts in parallel (rate-limited by analysisLimiter)
    const postFlagArrays = await Promise.allSettled(
      posts.map((post) => analyzePostForSEBI(post, openaiClient)),
    );

    const allPostFlags: any[] = [];
    for (const result of postFlagArrays) {
      if (result.status === 'fulfilled') allPostFlags.push(...result.value);
    }

    // Check registration disclosure separately (regex-based)
    const { hasSEBIReg, regNumber, flags: regFlags } = checkRegistrationDisclosure(
      profile,
      posts,
    );

    const rules = buildRuleResults(allPostFlags, regFlags);
    const score = calculateSEBIScore(rules);

    trace.update({ output: { score, flagCount: allPostFlags.length + regFlags.length } });
    await langfuse.flushAsync();

    return { rules, hasSEBIRegistration: hasSEBIReg, sebiRegistrationNumber: regNumber, score };
  } catch (error: any) {
    trace.update({ output: { success: false, error: error.message } });
    await langfuse.flushAsync();
    throw error;
  }
}
