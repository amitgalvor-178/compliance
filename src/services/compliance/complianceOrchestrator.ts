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
  type TranscriptSegment,
  type RuleFlag,
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
  videosFailed: number,
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

  if (videosFailed > 0) {
    notes.push(
      `${videosFailed} video post(s) could not be transcribed — analysis based on captions only for those posts`,
    );
  }

  if (notes.length === 0) {
    notes.push('No significant compliance issues detected across analyzed posts');
  }

  return notes;
}

// ─── Timestamp annotation ─────────────────────────────────────────────────────

function findTimestamp(excerpt: string, segments: TranscriptSegment[]): number | null {
  if (!excerpt || !segments.length) return null;

  const needle = excerpt.toLowerCase().slice(0, 80);

  // Build full text with character-offset tracking
  let charPos = 0;
  const segRanges = segments.map((seg) => {
    const start = charPos;
    charPos += seg.text.length + 1;
    return { seg, start, end: charPos };
  });

  const fullText = segments.map((s) => s.text).join(' ').toLowerCase();
  const idx = fullText.indexOf(needle);
  if (idx !== -1) {
    const match = segRanges.find((r) => r.start <= idx && idx < r.end);
    if (match) return match.seg.start;
  }

  // Fuzzy fallback: find segment with most keyword overlap
  const keywords = needle.split(/\s+/).filter((w) => w.length > 3);
  if (!keywords.length) return null;

  let bestSeg: TranscriptSegment | null = null;
  let bestScore = 0;
  for (const seg of segments) {
    const segLow = seg.text.toLowerCase();
    const score = keywords.filter((w) => segLow.includes(w)).length;
    if (score > bestScore) { bestScore = score; bestSeg = seg; }
  }
  return bestScore > 0 ? bestSeg!.start : null;
}

function annotateTimestamps(
  flags: RuleFlag[],
  segmentMap: Map<string, TranscriptSegment[]>,
): void {
  for (const flag of flags) {
    if (flag.timestampSeconds != null || !flag.excerpt) continue;
    const segments = segmentMap.get(flag.postId);
    if (!segments?.length) continue;
    const ts = findTimestamp(flag.excerpt, segments);
    if (ts != null) flag.timestampSeconds = Math.round(ts);
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function runCompliancePipeline(
  instagramHandle: string,
  onStep?: (step: number) => void,
): Promise<ComplianceReport> {
  console.log(`[compliance] Starting pipeline for @${instagramHandle}`);

  // 1. Fetch profile
  onStep?.(0);
  const profile = await fetchCreatorProfile(instagramHandle);
  console.log(`[compliance] Profile fetched: ${profile.name} (${profile.followersCount} followers)`);

  // 2. Fetch posts via Business Discovery (direct /{id}/media is blocked for external accounts)
  const rawPosts = await fetchCreatorPosts(instagramHandle, POST_LIMIT);
  console.log(`[compliance] ${rawPosts.length} posts fetched`);

  // 3. Transcribe videos (best-effort, parallel)
  // Cap at 5 videos; skip if caption is already detailed (>200 chars); 15s timeout per video
  onStep?.(1);
  const MAX_TRANSCRIPTIONS = 5;
  const TRANSCRIPTION_TIMEOUT_MS = 15_000;
  let videosScheduled = 0;

  const postContents: PostContent[] = await Promise.all(
    rawPosts.map(async (post): Promise<PostContent> => {
      let transcript: string | null = null;
      let transcriptSegments: TranscriptSegment[] | undefined;
      let transcriptionFailed = false;

      const isVideo = post.mediaType === 'VIDEO' || post.mediaType === 'REEL';
      const captionLong = (post.caption || '').length > 200;
      const shouldTranscribe = isVideo && post.mediaUrl && !captionLong && videosScheduled < MAX_TRANSCRIPTIONS;

      if (shouldTranscribe) {
        videosScheduled++;
        try {
          const timeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Transcription timeout')), TRANSCRIPTION_TIMEOUT_MS),
          );
          const result = await Promise.race([transcribeFromUrl(post.mediaUrl!, post.id), timeout]);
          transcript = result.text;
          transcriptSegments = result.segments;
        } catch (err) {
          console.warn(`[compliance] Transcription failed for post ${post.id}:`, err);
          transcriptionFailed = true;
        }
      }

      return {
        postId: post.id,
        caption: post.caption || '',
        transcript,
        transcriptSegments,
        timestamp: post.timestamp,
        mediaType: post.mediaType,
        thumbnailUrl: post.thumbnailUrl || post.mediaUrl,
        permalink: post.permalink,
        transcriptionFailed,
      };
    }),
  );

  const postsTranscribed = postContents.filter((p) => p.transcript !== null).length;
  // Only count genuine failures (attempted but failed) — not images or intentional skips
  const videosFailed = postContents.filter((p) => p.transcriptionFailed === true).length;

  // Build postMedia map for frontend thumbnail + link display
  const postMedia: Record<string, { thumbnail?: string; permalink?: string }> = {};
  for (const p of postContents) {
    if (p.thumbnailUrl || p.permalink) {
      postMedia[p.postId] = { thumbnail: p.thumbnailUrl, permalink: p.permalink };
    }
  }
  console.log(`[compliance] Transcribed ${postsTranscribed}/${postContents.length} video posts`);

  // 4. SEBI analysis
  onStep?.(2);
  const sebiCompliance = await analyzeSEBICompliance(profile, postContents);

  // 5. Brand safety analysis
  onStep?.(3);
  const brandSafety = await analyzeBrandSafety(postContents);

  console.log(
    `[compliance] SEBI score: ${sebiCompliance.score} | Brand safety score: ${brandSafety.score}`,
  );

  // Annotate flags with video timestamps where possible
  const segmentMap = new Map<string, TranscriptSegment[]>(
    postContents
      .filter((p) => p.transcriptSegments?.length)
      .map((p) => [p.postId, p.transcriptSegments!]),
  );
  const allFlags = [
    ...Object.values(sebiCompliance.rules).flatMap((r) => r.flags),
    ...Object.values(brandSafety.rules).flatMap((r) => r.flags),
  ];
  annotateTimestamps(allFlags, segmentMap);

  // 6. Score + verdict
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

  const summaryNotes = buildSummaryNotes(partial, videosFailed);

  return {
    reportId: uuidv4(),
    createdAt: new Date().toISOString(),
    ...partial,
    summaryNotes,
  };
}
