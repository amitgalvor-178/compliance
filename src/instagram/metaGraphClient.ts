import dotenv from 'dotenv';
import type { InstagramProfile, InstagramPost } from '../types/index.js';

dotenv.config();

const META_GRAPH_BASE = 'https://graph.facebook.com/v21.0';

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
 * Requires: Instagram Business account with page access token.
 */
export async function fetchCreatorProfile(handle: string): Promise<InstagramProfile> {
  const igUserId = getIGUserId();
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

  const url =
    `${META_GRAPH_BASE}/${igUserId}` +
    `?fields=business_discovery.fields(${fields})` +
    `&username=${encodeURIComponent(handle)}` +
    `&access_token=${token}`;

  const data = await metaFetch<{ business_discovery: any }>(url);
  const bd = data.business_discovery;

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
 * Diagnostic: returns env var state + raw Meta API response for a test handle.
 * Only called from the /api/compliance/debug route — never in production flow.
 */
export async function debugMetaCredentials(testHandle = 'instagram'): Promise<{
  igUserIdSet: boolean;
  igUserIdPrefix: string;
  tokenSet: boolean;
  tokenPrefix: string;
  requestUrl: string;
  rawResponse: unknown;
  error?: string;
}> {
  const igUserId = process.env.META_IG_USER_ID || '';
  const token = process.env.META_ACCESS_TOKEN || '';

  const fields = 'id,username,name,biography,followers_count';
  const url =
    `${META_GRAPH_BASE}/${igUserId}` +
    `?fields=business_discovery.fields(${fields})` +
    `&username=${encodeURIComponent(testHandle)}` +
    `&access_token=${token}`;

  const safeUrl = url.replace(token, token.slice(0, 10) + '...');

  try {
    const res = await fetch(url);
    const raw = await res.json().catch(() => ({ _parseError: true }));
    return {
      igUserIdSet: !!igUserId,
      igUserIdPrefix: igUserId.slice(0, 6) + (igUserId.length > 6 ? '...' : ''),
      tokenSet: !!token,
      tokenPrefix: token.slice(0, 10) + (token.length > 10 ? '...' : ''),
      requestUrl: safeUrl,
      rawResponse: raw,
      error: res.ok ? undefined : `HTTP ${res.status}`,
    };
  } catch (err: any) {
    return {
      igUserIdSet: !!igUserId,
      igUserIdPrefix: igUserId.slice(0, 6) + (igUserId.length > 6 ? '...' : ''),
      tokenSet: !!token,
      tokenPrefix: token.slice(0, 10) + (token.length > 10 ? '...' : ''),
      requestUrl: safeUrl,
      rawResponse: null,
      error: err.message,
    };
  }
}

/**
 * Fetch the most recent posts for a creator using their IG user ID.
 * media_url is available for both images and videos on public business accounts.
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
