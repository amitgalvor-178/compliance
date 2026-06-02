/**
 * Main compliance pipeline orchestrator.
 *
 * Flow:
 *  1. Fetch creator profile via Meta Business Discovery API
 *  2. Fetch last 25 posts
 *  3. Transcribe VIDEO/REEL posts with Whisper (parallel, best-effort)
 *  4. Run SEBI compliance analysis (LLM + regex)
 *  5. Run brand safety analysis (OpenAI Moderation + regex)
 *  6. Calculate overall score + verdict
 *  7. Return ComplianceReport
 */

import { v4 as uuidv4 } from 'uuid';
import { fetchCreatorProfile, fetchCreatorPosts } from '../../instagram/metaGraphClient.js';
import { transcribeFromUrl } from '../transcription.js';
import { analyzeSEBICompliance } from '../sebi/sebiComplianceAnalyzer.js';
import { analyzeBrandSafety } from '../brandSafety/brandSafetyAnalyzer.js';
import { CRITICAL_SEBI_RULE_IDS } from '../sebi/sebiRules.js';
import {
  RuleStatus,
  OverallVerdict,
  type PostContent,
  type ComplianceReport,
} from '../../types/index.js';

const POST_LIMIT = 12;

// ─── Scoring ──────────────────────────────────────────────────────────────────

function calculateOverallScore(sebiScore: number, brandScore: number): number {
  return Math.round(sebiScore * 0.6 + brandScore * 0.4);
}

function calculateVerdict(
  overallScore: number,
  sebiResult: Awaited<ReturnType<typeof analyzeSEBICompliance>>,
): OverallVerdict {
  const hasCriticalSEBIFail = CRITICAL_SEBI_RULE_IDS.some(
    (id) => sebiResult.rules[id]?.status === RuleStatus.FAIL,
  );

  if (hasCriticalSEBIFail || overallScore < 50) {
    return OverallVerdict.NON_COMPLIANT;
  }

  if (overallScore >= 80) {
    return OverallVerdict.COMPLIANT;
  }

  return OverallVerdict.REVIEW_REQUIRED;
}

function buildSummaryNotes(
  report: Omit<ComplianceReport, 'summaryNotes' | 'reportId' | 'createdAt'>,
): string[] {
  const notes: string[] = [];

  if (report.sebiCompliance.hasSEBIRegistration) {
    notes.push(
      `SEBI registration found in bio: ${report.sebiCompliance.sebiRegistrationNumber}`,
    );
  } else {
    const financialPost = Object.values(report.sebiCompliance.rules).some(
      (r) => r.flags.length > 0,
    );
    if (financialPost) {
      notes.push('No SEBI registration number detected in creator bio');
    }
  }

  const sebiFails = Object.values(report.sebiCompliance.rules).filter(
    (r) => r.status === RuleStatus.FAIL,
  );
  if (sebiFails.length > 0) {
    notes.push(
      `${sebiFails.length} SEBI rule(s) violated: ${sebiFails.map((r) => r.ruleName).join(', ')}`,
    );
  }

  const brandFails = Object.values(report.brandSafety.rules).filter(
    (r) => r.status === RuleStatus.FAIL,
  );
  if (brandFails.length > 0) {
    notes.push(
      `${brandFails.length} brand safety issue(s): ${brandFails.map((r) => r.ruleName).join(', ')}`,
    );
  }

  if (report.postsTranscribed < report.postsAnalyzed) {
    notes.push(
      `${report.postsAnalyzed - report.postsTranscribed} video post(s) could not be transcribed — analysis based on captions only for those posts`,
    );
  }

  if (notes.length === 0) {
    notes.push('No significant compliance issues detected across analyzed posts');
  }

  return notes;
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function runCompliancePipeline(
  instagramHandle: string,
): Promise<ComplianceReport> {
  console.log(`[compliance] Starting pipeline for @${instagramHandle}`);

  // 1. Fetch profile
  const profile = await fetchCreatorProfile(instagramHandle);
  console.log(`[compliance] Profile fetched: ${profile.name} (${profile.followersCount} followers)`);

  // 2. Fetch posts via Business Discovery (direct /{id}/media is blocked for external accounts)
  const rawPosts = await fetchCreatorPosts(instagramHandle, POST_LIMIT);
  console.log(`[compliance] ${rawPosts.length} posts fetched`);

  // 3. Transcribe videos (best-effort, parallel)
  const postContents: PostContent[] = await Promise.all(
    rawPosts.map(async (post): Promise<PostContent> => {
      let transcript: string | null = null;
      let transcriptionFailed = false;

      const isVideo = post.mediaType === 'VIDEO' || post.mediaType === 'REEL';
      if (isVideo && post.mediaUrl) {
        try {
          const result = await transcribeFromUrl(post.mediaUrl, post.id);
          transcript = result.text;
        } catch (err) {
          console.warn(`[compliance] Transcription failed for post ${post.id}:`, err);
          transcriptionFailed = true;
        }
      }

      return {
        postId: post.id,
        caption: post.caption || '',
        transcript,
        timestamp: post.timestamp,
        mediaType: post.mediaType,
        thumbnailUrl: post.thumbnailUrl || post.mediaUrl,
        permalink: post.permalink,
        transcriptionFailed,
      };
    }),
  );

  const postsTranscribed = postContents.filter((p) => p.transcript !== null).length;

  // Build postMedia map for frontend thumbnail + link display
  const postMedia: Record<string, { thumbnail?: string; permalink?: string }> = {};
  for (const p of postContents) {
    if (p.thumbnailUrl || p.permalink) {
      postMedia[p.postId] = { thumbnail: p.thumbnailUrl, permalink: p.permalink };
    }
  }
  console.log(`[compliance] Transcribed ${postsTranscribed}/${postContents.length} video posts`);

  // 4 & 5. Run SEBI + Brand Safety analysis in parallel
  const [sebiCompliance, brandSafety] = await Promise.all([
    analyzeSEBICompliance(profile, postContents),
    analyzeBrandSafety(postContents),
  ]);

  console.log(
    `[compliance] SEBI score: ${sebiCompliance.score} | Brand safety score: ${brandSafety.score}`,
  );

  // 6. Calculate overall score + verdict
  const overallScore = calculateOverallScore(sebiCompliance.score, brandSafety.score);
  const verdict = calculateVerdict(overallScore, sebiCompliance);

  const partial = {
    creator: profile,
    postsAnalyzed: postContents.length,
    postsTranscribed,
    postMedia,
    sebiCompliance,
    brandSafety,
    overallScore,
    verdict,
  };

  const summaryNotes = buildSummaryNotes(partial);

  return {
    reportId: uuidv4(),
    createdAt: new Date().toISOString(),
    ...partial,
    summaryNotes,
  };
}
