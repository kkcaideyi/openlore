import { z } from "zod";

const RESERVED_PATHS = new Set([
  "compose", "explore", "hashtag", "home", "i", "intent", "login", "logout",
  "messages", "notifications", "privacy", "search", "settings", "share", "signup", "tos",
]);
const X_HOSTS = /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/i;

/** Accept only an X/Twitter profile URL so the collector never receives an arbitrary request target. */
export function parseXProfile(value: string): { handle: string; url: string } | null {
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || !X_HOSTS.test(url.hostname) || url.username || url.password || url.port)
      return null;
    const parts = url.pathname.split("/").filter(Boolean);
    const handle = parts[0]?.replace(/^@/, "") || "";
    if (parts.length !== 1 || !/^\w{1,15}$/.test(handle) || RESERVED_PATHS.has(handle.toLowerCase())) return null;
    return { handle, url: `https://x.com/${handle}` };
  } catch {
    return null;
  }
}

/** X and Twitter status URLs are aliases; the post ID is the only stable identity. */
export function xStatusId(url: URL): string | null {
  if (!X_HOSTS.test(url.hostname)) return null;
  return /^\/(?:i\/web|i|\w{1,15})\/status(?:es)?\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1] || null;
}

const XUserSchema = z.object({ id: z.string().regex(/^\d+$/), handle: z.string(), name: z.string() });
const XPostCoreSchema = z.object({
  id: z.string().regex(/^\d+$/),
  url: z.string().url(),
  created_at: z.string(),
  author: XUserSchema,
  text: z.string(),
});
export const XPostSchema = XPostCoreSchema.extend({
  lang: z.string().nullable().default(null),
  conversation_id: z.string().nullable().default(null),
  in_reply_to: z.object({ post_id: z.string(), handle: z.string().nullable() }).nullable().default(null),
  quoted: XPostCoreSchema.nullable().default(null),
  links: z.array(z.object({ url: z.string(), display: z.string().nullable().default(null) })).default([]),
  media: z.array(z.object({ kind: z.enum(["photo", "video", "animated_gif"]), url: z.string() })).default([]),
  pinned: z.boolean().default(false),
});
export type XPost = z.infer<typeof XPostSchema>;

/** Collector checkpoint. `newest_id` advances only after a scan reaches the previous one. */
export const XUserStateSchema = z.object({
  user_id: z.string().nullable().default(null),
  newest_id: z.string().nullable().default(null),
  pending: z.object({ cursor: z.string(), top_id: z.string(), stop_id: z.string() }).nullable().default(null),
});
export type XUserState = z.infer<typeof XUserStateSchema>;

export const XCollectDataSchema = z.object({
  user: XUserSchema.nullable(),
  posts: z.array(XPostSchema).max(1000),
  next_state: XUserStateSchema,
  scan: z.enum(["complete", "more", "limited"]),
  requests: z.number().int().nonnegative(),
  issues: z.array(z.string()).default([]),
});
export type XCollectData = z.infer<typeof XCollectDataSchema>;
