/**
 * SEBI compliance analyzer.
 *
 * All posts are analyzed in a single batched LLM call instead of one call
 * per post — reduces 12 roundtrips to 1.
 * MISSING_REG_DISCLOSURE is handled via regex on bio + transcript start.
 */

import { z } from 'zod';
import { openai } from '../../config/openai.js';
import { langfuse } from '../../config/langfuse.js';
import {
  SEBIRuleId,
  RuleStatus,
  type PostContent,
  type InstagramProfile,
  type SEBIComplianceResult,
  type RuleResult,
  type RuleFlag,
} from '../../types/index.js';
import {
  SEBI_RULES,
  extractSEBIRegistration,
} from './sebiRules.js';

// ─── Zod schema for batched LLM output ───────────────────────────────────────

const FlagSchema = z.object({
  rule_id: z.string(),
  is_flagged: z.boolean(),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  excerpt: z.string(),
  explanation: z.string(),
});

const BatchAnalysisSchema = z.object({
  posts: z.array(
    z.object({
      post_id: z.string(),
      violations: z.array(FlagSchema),
    }),
  ),
});

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  const ruleDescriptions = SEBI_RULES.filter(
    (r) => r.id !== SEBIRuleId.MISSING_REG_DISCLOSURE,
  )
    .map((r) => `### ${r.id}\nName: ${r.name}\nSource: ${r.source}\n${r.llmGuidance}`)
    .join('\n\n');

  return `You are a SEBI (Securities and Exchange Board of India) compliance analyst.
Analyze multiple Instagram posts and identify violations of SEBI regulations.

Rules to check:
${ruleDescriptions}

For each post, return a "violations" array with ALL rules (even non-flagged ones):
- rule_id: the rule identifier
- is_flagged: true only if a genuine violation is detected
- severity: critical/high/medium/low
- excerpt: exact problematic text (max 120 chars), empty string if not flagged
- explanation: brief reason (max 180 chars), empty string if not flagged

Be precise — only flag genuine violations, not general financial discussion.`;
}

function buildUserMessage(posts: PostContent[]): string {
  const lines = posts.map((p, i) => {
    const caption = (p.caption || '').slice(0, 400);
    const transcript = p.transcript ? p.transcript.slice(0, 600) : '';
    const parts = [`[POST ${i + 1}] post_id: ${p.postId}`];
    if (caption) parts.push(`Caption: ${caption}`);
    if (transcript) parts.push(`Transcript: ${transcript}`);
    return parts.join('\n');
  });
  return lines.join('\n\n---\n\n');
}

// ─── Batched LLM analysis (single call for all posts) ─────────────────────────

async function analyzeAllPostsForSEBI(
  posts: PostContent[],
): Promise<Array<{ postId: string; flags: any[] }>> {
  const postsWithContent = posts.filter(
    (p) => (p.caption || '').trim() || (p.transcript || '').trim(),
  );
  if (postsWithContent.length === 0) return [];

  const ruleIds = SEBI_RULES.filter((r) => r.id !== SEBIRuleId.MISSING_REG_DISCLOSURE).map(
    (r) => r.id,
  );

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: buildUserMessage(postsWithContent) },
    ],
    temperature: 0.1,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'sebi_batch_analysis',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            posts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  post_id: { type: 'string' },
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
                required: ['post_id', 'violations'],
                additionalProperties: false,
              },
            },
          },
          required: ['posts'],
          additionalProperties: false,
        },
      },
    },
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) return [];

  const parsed = BatchAnalysisSchema.parse(JSON.parse(raw));

  return parsed.posts.map((p) => ({
    postId: p.post_id,
    flags: p.violations
      .filter((v) => v.is_flagged)
      .map((v) => ({
        postId: p.post_id,
        excerpt: v.excerpt,
        explanation: v.explanation,
        severity: v.severity,
        _ruleId: v.rule_id,
      })),
  }));
}

// ─── Registration disclosure check ───────────────────────────────────────────

function checkRegistrationDisclosure(
  profile: InstagramProfile,
  posts: PostContent[],
): { hasSEBIReg: boolean; regNumber?: string; flags: RuleFlag[] } {
  const bioReg = extractSEBIRegistration(profile.biography);

  const financialKeywords =
    /\b(stock|share|mutual fund|trading|invest|nifty|sensex|equity|portfolio|demat|broker|ipo|sebi)\b/i;

  const financialPosts = posts.filter(
    (p) =>
      financialKeywords.test(p.caption || '') || financialKeywords.test(p.transcript || ''),
  );

  if (financialPosts.length === 0) {
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
  postResults: Array<{ postId: string; flags: any[] }>,
  regDisclosureFlags: RuleFlag[],
): Record<SEBIRuleId, RuleResult> {
  const allPostFlags = postResults.flatMap((p) => p.flags);
  const results = {} as Record<SEBIRuleId, RuleResult>;

  for (const rule of SEBI_RULES) {
    const flags =
      rule.id === SEBIRuleId.MISSING_REG_DISCLOSURE
        ? regDisclosureFlags
        : allPostFlags
            .filter((f) => f._ruleId === rule.id)
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
  const points: number[] = Object.values(rules).map((r) => {
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
    const [postResults, regCheck] = await Promise.all([
      analyzeAllPostsForSEBI(posts),
      Promise.resolve(checkRegistrationDisclosure(profile, posts)),
    ]);

    const rules = buildRuleResults(postResults, regCheck.flags);
    const score = calculateSEBIScore(rules);

    trace.update({ output: { score, postResults: postResults.length } });
    await langfuse.flushAsync();

    return {
      rules,
      hasSEBIRegistration: regCheck.hasSEBIReg,
      sebiRegistrationNumber: regCheck.regNumber,
      score,
    };
  } catch (error: any) {
    trace.update({ output: { success: false, error: error.message } });
    await langfuse.flushAsync();
    throw error;
  }
}
