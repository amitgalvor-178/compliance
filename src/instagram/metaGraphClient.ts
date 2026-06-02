import dotenv from 'dotenv';
import type { InstagramProfile, InstagramPost } from '../types/index.js';

dotenv.config();

const META_GRAPH_BASE = 'https://graph.facebook.com/v24.0';

function getAccessToken(): string {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error('META_ACCESS_TOKEN is not set');
  return token;
}

function getIGUserId(): string {
  const userId = process.env.META_IG_USER_ID;
  if (!userId) throw new Error('META_IG_USER_ID is not set');
  return userId;
}

function getPageId(): string {
  return process.env.META_PAGE_ID || '';
}

async function metaFetch<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({ error: { message: res.statusText } }))) as any;
    throw new Error(`Meta API error (${res.status}): ${err?.error?.message ?? res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Fetch public profile of any Instagram Business/Creator account using
 * the Business Discovery API from our own IG Business account.
 *
 * Tries the IG User ID node first; falls back to Facebook Page ID node
 * if META_PAGE_ID is set, since some token types only work via the page node.
 */
export async function fetchCreatorProfile(handle: string): Promise<InstagramProfile> {
  const igUserId = getIGUserId();
  const pageId = getPageId();
  const token = getAccessToken();

  const fields = [
    'id',
    'username',
    'name',
    'biography',
    'profile_picture_url',
    'followers_count',
    'media_count',
    'website',
  ].join(',');

  // Primary: call via IG User ID node (standard Business Discovery)
  const igUrl =
    `${META_GRAPH_BASE}/${igUserId}` +
    `?fields=business_discovery.fields(${fields})` +
    `&username=${encodeURIComponent(handle)}` +
    `&access_token=${token}`;

  try {
    const data = await metaFetch<{ business_discovery: any }>(igUrl);
    return mapProfile(data.business_discovery);
  } catch (err: any) {
    // Fallback: call via Facebook Page ID node (works with Page Access Tokens)
    if (pageId && err.message.includes('#100')) {
      const pageUrl =
        `${META_GRAPH_BASE}/${pageId}` +
        `?fields=business_discovery.fields(${fields})` +
        `&username=${encodeURIComponent(handle)}` +
        `&access_token=${token}`;
      const data = await metaFetch<{ business_discovery: any }>(pageUrl);
      return mapProfile(data.business_discovery);
    }
    throw err;
  }
}

function mapProfile(bd: any): InstagramProfile {
  return {
    id: bd.id,
    username: bd.username,
    name: bd.name || bd.username,
    biography: bd.biography || '',
    profilePictureUrl: bd.profile_picture_url || '',
    followersCount: bd.followers_count || 0,
    mediaCount: bd.media_count || 0,
    website: bd.website,
  };
}

/**
 * Diagnostic: tests both IG User ID and Page ID approaches and returns
 * raw Meta API responses + token permissions.
 */
export async function debugMetaCredentials(testHandle = 'instagram'): Promise<{
  igUserId: string;
  pageId: string;
  tokenPrefix: string;
  igUserIdApproach: { url: string; response: unknown; ok: boolean };
  pageIdApproach: { url: string; response: unknown; ok: boolean } | null;
  permissionsResponse: unknown;
}> {
  const igUserId = process.env.META_IG_USER_ID || '';
  const pageId = process.env.META_PAGE_ID || '';
  const token = process.env.META_ACCESS_TOKEN || '';

  const fields = 'id,username,name,biography,followers_count';
  const mask = (u: string) => u.replace(token, token.slice(0, 12) + '...');

  const igUrl =
    `${META_GRAPH_BASE}/${igUserId}` +
    `?fields=business_discovery.fields(${fields})` +
    `&username=${encodeURIComponent(testHandle)}` +
    `&access_token=${token}`;

  const pageUrl = pageId
    ? `${META_GRAPH_BASE}/${pageId}` +
      `?fields=business_discovery.fields(${fields})` +
      `&username=${encodeURIComponent(testHandle)}` +
      `&access_token=${token}`
    : null;

  const permUrl = `${META_GRAPH_BASE}/me/permissions?access_token=${token}`;

  const [igRes, pageRes, permRes] = await Promise.all([
    fetch(igUrl).then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => null) })),
    pageUrl
      ? fetch(pageUrl).then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => null) }))
      : Promise.resolve(null),
    fetch(permUrl).then(async (r) => r.json().catch(() => null)),
  ]);

  return {
    igUserId,
    pageId: pageId || '(not set — add META_PAGE_ID env var)',
    tokenPrefix: token.slice(0, 12) + (token.length > 12 ? '...' : ''),
    igUserIdApproach: { url: mask(igUrl), response: igRes.body, ok: igRes.ok },
    pageIdApproach: pageRes
      ? { url: mask(pageUrl!), response: pageRes.body, ok: pageRes.ok }
      : null,
    permissionsResponse: permRes,
  };
}

/**
 * Fetch the most recent posts for a creator using their IG user ID.
 */
export async function fetchCreatorPosts(
  creatorIgId: string,
  limit = 25,
): Promise<InstagramPost[]> {
  const token = getAccessToken();

  const fields = [
    'id',
    'caption',
    'media_type',
    'media_url',
    'thumbnail_url',
    'timestamp',
    'like_count',
    'comments_count',
  ].join(',');

  const url =
    `${META_GRAPH_BASE}/${creatorIgId}/media` +
    `?fields=${fields}` +
    `&limit=${limit}` +
    `&access_token=${token}`;

  const data = await metaFetch<{ data: any[] }>(url);

  return (data.data || []).map(
    (post: any): InstagramPost => ({
      id: post.id,
      caption: post.caption,
      mediaType: post.media_type,
      mediaUrl: post.media_url,
      thumbnailUrl: post.thumbnail_url,
      timestamp: post.timestamp,
      likeCount: post.like_count,
      commentsCount: post.comments_count,
    }),
  );
}
