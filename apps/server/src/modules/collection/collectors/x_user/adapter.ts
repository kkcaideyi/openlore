import path from 'node:path';
import {
  parseXProfile,
  XCollectDataSchema,
  XUserStateSchema,
  type CollectionError,
  type CollectionRequest,
  type CollectionResult,
  type ContentItem,
  type XPost,
} from '@openlore/contracts';
import { getAppPaths } from '../../../../infrastructure/config/paths.js';
import { pythonWorkerRunner } from '../../../../infrastructure/python/runner.js';
import type { CollectorAdapter } from '../../registry.js';

const PAGE_SIZE = 40; // twscrape UserTweets page size
const SOFT_DEADLINE_SECONDS = 50; // the worker returns partial results before the hard kill
const HARD_TIMEOUT_MS = 70_000;
const TWITTER_EPOCH = 1288834974657n;

export const xAccountsDb = () => path.join(getAppPaths().dataDir, 'x', 'accounts.db');

/** Snowflake IDs embed their creation time, an independent check of the API date. */
export function snowflakeTime(id: string): string | null {
  if (!/^\d{15,20}$/.test(id)) return null;
  return new Date(Number((BigInt(id) >> 22n) + TWITTER_EPOCH)).toISOString();
}

export function postItem(post: XPost, sourceId: string, fetchedAt: string): ContentItem {
  const handle = post.author.handle;
  const lines = [post.text];
  if (post.quoted)
    lines.push('', `引用 @${post.quoted.author.handle}（${post.quoted.url}）：`, ...post.quoted.text.split('\n').map((line) => `> ${line}`));
  if (post.links.length) lines.push('', '链接：', ...post.links.map((link) => `- ${link.url}`));
  if (post.media.length) {
    const counts = post.media.reduce<Record<string, number>>((all, item) => ({ ...all, [item.kind]: (all[item.kind] || 0) + 1 }), {});
    const labels: Record<string, string> = { photo: '图片', video: '视频', animated_gif: '动图' };
    lines.push('', `媒体：${Object.entries(counts).map(([kind, n]) => `${labels[kind]} ${n}`).join('，')}（未转写）`);
  }
  const snowflake = snowflakeTime(post.id);
  const verified = Boolean(snowflake && Math.abs(Date.parse(snowflake) - Date.parse(post.created_at)) < 300_000);
  const excerpt = Array.from(post.text.replace(/\s+/g, ' ').trim());
  const title = excerpt.length ? `${excerpt.slice(0, 60).join('')}${excerpt.length > 60 ? '…' : ''}` : `帖子 ${post.id}`;
  return {
    source_item_id: `${sourceId}:x:${post.id}`,
    source_id: sourceId,
    native_id: post.id,
    original_url: post.url,
    final_url: post.url,
    canonical_url: `https://x.com/i/status/${post.id}`,
    categories: [],
    date_evidence: { verified, conflict: Boolean(snowflake) && !verified, source: 'x_api', x_created_at: post.created_at, snowflake_at: snowflake },
    title: `@${handle}：${title}`,
    author: `${post.author.name} (@${handle})`,
    published_at: post.created_at,
    updated_at: null,
    body: { value: lines.join('\n').trim(), format: 'text', completeness: post.text.trim() ? 'full' : 'empty' },
    attachments: post.media.map((item) => ({ url: item.url, kind: item.kind, fetched: false })),
    fetched_at: fetchedAt,
    fetch_method: 'x_user',
    raw_ref: null,
    issues: [
      ...(post.quoted ? ['x_quote'] : []),
      ...(post.in_reply_to ? ['x_self_reply'] : []),
      ...(post.pinned ? ['x_pinned'] : []),
      ...(post.text.trim() ? [] : ['x_media_only']),
    ],
  };
}

export class XUserCollectorAdapter implements CollectorAdapter {
  id = 'x_user';
  supportedOperations: Array<'discover' | 'fetch'> = ['discover'];
  // One session store: overlapping runs would see twscrape's in-use lock as a rate limit.
  private queue: Promise<unknown> = Promise.resolve();

  collect(request: CollectionRequest): Promise<CollectionResult> {
    const run = this.queue.then(() => this.run(request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async run(request: CollectionRequest): Promise<CollectionResult> {
    const observedAt = new Date().toISOString();
    const result = (status: CollectionResult['status'], errors: CollectionError[], extra: Partial<CollectionResult> = {}): CollectionResult => ({
      run_id: request.run_id,
      source_id: request.source_id,
      capability_id: this.id,
      status,
      items: [],
      next_state: request.state || null,
      scan: 'unknown',
      errors,
      observed_at: observedAt,
      stats: { requests: 0, items_observed: 0, items_returned: 0 },
      ...extra,
    });
    if (request.operation !== 'discover')
      return result('failed', [{ code: 'unsupported_operation', message: `x_user does not support operation '${request.operation}'`, retryable: false }]);
    const profile = parseXProfile(request.target.url);
    if (!profile)
      return result('failed', [{ code: 'invalid_target', message: 'X 来源地址必须是账号主页，例如 https://x.com/simonw', retryable: false }]);
    const state = XUserStateSchema.safeParse(request.state || {});
    let response;
    try {
      response = await pythonWorkerRunner.run({
        protocol_version: 1,
        job_id: request.run_id,
        operation: 'collect_x_user',
        handle: profile.handle,
        accounts_db: xAccountsDb(),
        state: state.success ? state.data : XUserStateSchema.parse({}),
        budget: {
          max_pages: Math.min(5, Math.max(1, Math.ceil(request.scope.limit / PAGE_SIZE))),
          deadline_seconds: SOFT_DEADLINE_SECONDS,
        },
      }, HARD_TIMEOUT_MS);
    } catch (error: any) {
      return result('failed', [{ code: 'worker_error', message: error.message, retryable: true }]);
    }
    const error: CollectionError | null = response.error
      ? { code: response.error.code, message: response.error.message, retryable: response.error.retryable, retry_after_seconds: response.error.retry_after_seconds ?? null }
      : null;
    const data = XCollectDataSchema.safeParse(response.data);
    if (response.status === 'failed' || !data.success)
      return result('failed', [error || { code: 'invalid_worker_output', message: 'X 采集器返回了不符合协议的数据', retryable: true }]);
    const items = data.data.posts.map((post) => postItem(post, request.source_id, observedAt));
    return result(response.status === 'partial' ? 'partial' : 'success', error ? [error] : [], {
      items,
      next_state: data.data.next_state,
      scan: data.data.scan,
      stats: { requests: data.data.requests, items_observed: items.length, items_returned: items.length },
    });
  }
}
