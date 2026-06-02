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
  const id = process.env.META_IG_USER_ID;
  if (!id) throw new Error('META_IG_USER_ID is not set');
  return id;
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
 * Exchange the stored User Access Token for a Page Access Token by calling
 * /me/accounts. The Page Access Token is required for Business Discovery API.
 * Returns null if the token is already a Page token or the page isn't found.
 */
async function fetchPageAccessToken(): Promise<{ pageId: string; pageToken: string } | null> {
  const userToken = getAccessToken();
  const igUserId = getIGUserId();

  const url =
    `${META_GRAPH_BASE}/me/accounts` +
    `?fields=id,name,access_token,instagram_business_account` +
    `&access_token=${userToken}`;

  try {
    const data = await metaFetch<{ data: any[] }>(url);
    const page = data.data?.find((p: any) => p.instagram_business_account?.id === igUserId);
    if (page?.access_token) {
      return { pageId: page.id as string, pageToken: page.access_token as string };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch public profile of any Instagram Business/Creator account using
 * the Business Discovery API.
 *
 * Strategy:
 *  1. Try IG User ID node + current token (works if token is already a Page token)
 *  2. On (#100): exchange for Page Access Token via /me/accounts, retry with Page ID
 */
export async function fetchCreatorProfile(handle: string): Promise<InstagramProfile> {
  const igUserId = getIGUserId();
  const token = getAccessToken();

  // username intentionally omitted from fields — passing it both here and as
  // the &username= query param causes Meta's parser to return (#100).
  // We populate username in mapProfile from the handle we already know.
  const fields = [
    'id',
    'name',
    'biography',
    'profile_picture_url',
    'followers_count',
    'media_count',
    'website',
  ].join(',');

  const buildUrl = (nodeId: string, tok: string) =>
    `${META_GRAPH_BASE}/${nodeId}` +
    `?fields=business_discovery.fields(${fields})` +
    `&username=${encodeURIComponent(handle)}` +
    `&access_token=${tok}`;

  // Attempt 1: IG User ID + stored token
  try {
    const data = await metaFetch<{ business_discovery: any }>(buildUrl(igUserId, token));
    return mapProfile(data.business_discovery, handle);
  } catch (err: any) {
    if (!err.message.includes('#100')) throw err;
  }

  // Attempt 2: exchange for Page Access Token and retry with Page ID node
  const page = await fetchPageAccessToken();
  if (!page) {
    throw new Error(
      'Business Discovery failed and no Page Access Token could be obtained. ' +
        'Ensure META_ACCESS_TOKEN is a valid User or Page Access Token with instagram_basic scope.',
    );
  }

  const data = await metaFetch<{ business_discovery: any }>(
    buildUrl(page.pageId, page.pageToken),
  );
  return mapProfile(data.business_discovery, handle);
}

function mapProfile(bd: any, handle?: string): InstagramProfile {
  return {
    id: bd.id,
    username: bd.username ?? handle ?? '',
    name: bd.name || bd.username || handle || '',
    biography: bd.biography || '',
    profilePictureUrl: bd.profile_picture_url || '',
    followersCount: bd.followers_count || 0,
    mediaCount: bd.media_count || 0,
    website: bd.website,
  };
}

/**
 * Diagnostic: tests multiple handles and field variants to isolate the issue.
 * Accepts an optional handle override (used by the ?handle= query param).
 */
export async function debugMetaCredentials(
  handleOverride?: string,
): Promise<Record<string, unknown>> {
  const userToken = getAccessToken();
  const igUserId = getIGUserId();
  const mask = (u: string) => u.replace(userToken, userToken.slice(0, 12) + '...');

  // Fetch page token
  const accountsUrl =
    `${META_GRAPH_BASE}/me/accounts` +
    `?fields=id,name,access_token,instagram_business_account` +
    `&access_token=${userToken}`;
  const accountsRes = (await fetch(accountsUrl).then((r) => r.json().catch(() => null))) as any;
  const pages: any[] = accountsRes?.data ?? [];
  const matchedPage = pages.find((p: any) => p.instagram_business_account?.id === igUserId);
  const pageId = matchedPage?.id ?? null;
  const pageToken = matchedPage?.access_token ?? null;
  const tok = pageToken ?? userToken;

  const fieldsWithUsername = 'id,username,name,biography,followers_count';
  const fieldsNoUsername = 'id,name,biography,followers_count';

  const buildUrl = (node: string, t: string, fields: string, handle: string) =>
    `${META_GRAPH_BASE}/${node}` +
    `?fields=business_discovery.fields(${fields})` +
    `&username=${encodeURIComponent(handle)}` +
    `&access_token=${t}`;

  const test = async (label: string, url: string) => {
    const r = await fetch(url);
    const body = await r.json().catch(() => null);
    return { label, ok: r.ok, status: r.status, url: mask(url), response: body };
  };

  // Test handles: user-specified, or a set of known public business accounts
  const handles = handleOverride
    ? [handleOverride]
    : ['nike', 'natgeo', 'zomato_in'];

  const tests = await Promise.all(
    handles.flatMap((h) => [
      // Without "username" in fields (avoids name collision with the &username= param)
      test(`igUserId | fields-no-username | handle=${h}`, buildUrl(igUserId, tok, fieldsNoUsername, h)),
      // With "username" in fields (original approach — may cause (#100))
      test(`igUserId | fields-with-username | handle=${h}`, buildUrl(igUserId, tok, fieldsWithUsername, h)),
    ]),
  );

  return {
    igUserId,
    pageId: pageId ?? '(not found)',
    pageTokenFound: !!pageToken,
    tokenUsed: pageToken ? 'pageToken' : 'userToken',
    tests,
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
