import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseXProfile, SourceOptionsSchema, type XPost } from '@openlore/contracts';
import { getSqliteDatabase, initDatabase } from '../src/infrastructure/persistence/sqlite/db.js';
import {
  PythonWorkerRunner,
  pythonWorkerRunner,
  redactDiagnostics,
  resolvePythonPath,
  workerEnv,
} from '../src/infrastructure/python/runner.js';
import { evaluateContent, normalizeUrl } from '../src/modules/collection/quality.js';
import { collectionService } from '../src/modules/collection/service.js';
import { collectorRegistry } from '../src/modules/collection/registry.js';
import { postItem, snowflakeTime, XUserCollectorAdapter } from '../src/modules/collection/collectors/x_user/adapter.js';
import { appScheduler } from '../src/modules/scheduler/scheduler.js';
import { sourcesService } from '../src/modules/sources/service.js';

const EPOCH = 1288834974657n;
const idAt = (date: Date) => ((BigInt(date.getTime()) - EPOCH) << 22n).toString();
const minutesAgo = (n: number) => new Date(Math.floor((Date.now() - n * 60000) / 1000) * 1000);
const text = 'We moved our agent eval harness to sandboxed workers; tracing shows retries dropped by 40% under load.';

function post(minutes: number, overrides: Partial<XPost> = {}): XPost {
  const created = minutesAgo(minutes);
  const id = idAt(created);
  return {
    id,
    url: `https://x.com/builder/status/${id}`,
    created_at: created.toISOString(),
    author: { id: '1', handle: 'builder', name: 'Builder' },
    text,
    lang: 'en',
    conversation_id: id,
    in_reply_to: null,
    quoted: null,
    links: [],
    media: [],
    pinned: false,
    ...overrides,
  };
}

const workerResult = (posts: XPost[], nextState: Record<string, unknown>, status: 'success' | 'partial' = 'success') => ({
  protocol_version: 1 as const,
  job_id: 'job',
  status,
  issues: [],
  error: status === 'partial' ? { code: 'x_timeout', message: 'X 采集超过本次时间预算', retryable: true } : null,
  data: { user: { id: '1', handle: 'builder', name: 'Builder' }, posts, next_state: nextState, scan: 'complete', requests: 2, issues: [] },
});

describe('X profile identity', () => {
  it('accepts only account profile URLs and canonicalizes status aliases by post ID', () => {
    expect(parseXProfile('https://twitter.com/@SimonW/')).toEqual({ handle: 'SimonW', url: 'https://x.com/SimonW' });
    expect(parseXProfile('https://mobile.x.com/karpathy?s=20')?.url).toBe('https://x.com/karpathy');
    for (const bad of ['https://x.com/home', 'https://x.com/a/status/1', 'https://example.com/a', 'https://x.com/name_that_is_far_too_long', 'ftp://x.com/a'])
      expect(parseXProfile(bad)).toBeNull();
    const canonical = 'https://x.com/i/status/1850000000000000000';
    for (const alias of [
      'https://twitter.com/SimonW/status/1850000000000000000?s=20',
      'https://mobile.twitter.com/simonw/statuses/1850000000000000000',
      'https://x.com/i/web/status/1850000000000000000/photo/1',
    ])
      expect(normalizeUrl(alias)).toBe(canonical);
    expect(normalizeUrl('https://x.com/simonw')).toBe('https://x.com/simonw');
  });

  it('maps a post to a content item with attribution and an independently checked date', () => {
    const quoted = post(30, { author: { id: '2', handle: 'other', name: 'Other' }, text: 'line one\nline two' });
    const item = postItem(post(5, {
      quoted: { id: quoted.id, url: quoted.url, created_at: quoted.created_at, author: quoted.author, text: quoted.text },
      links: [{ url: 'https://example.com/evals', display: null }],
      media: [{ kind: 'photo', url: 'https://pbs.twimg.com/a.jpg' }],
    }), 'src', new Date().toISOString());
    expect(item.source_item_id).toBe(`src:x:${item.native_id}`);
    expect(item.canonical_url).toBe(`https://x.com/i/status/${item.native_id}`);
    expect(item.title).toMatch(/^@builder：We moved our agent eval harness/);
    expect(item.title!.endsWith('…')).toBe(true);
    expect(item.author).toBe('Builder (@builder)');
    expect(item.date_evidence).toMatchObject({ verified: true, conflict: false, source: 'x_api' });
    expect(item.body.value).toContain(`引用 @other（${quoted.url}）：\n> line one\n> line two`);
    expect(item.body.value).toContain('链接：\n- https://example.com/evals');
    expect(item.body.value).toContain('媒体：图片 1（未转写）');
    expect(item.attachments).toEqual([{ url: 'https://pbs.twimg.com/a.jpg', kind: 'photo', fetched: false }]);
    expect(item.issues).toContain('x_quote');
    expect(snowflakeTime(item.native_id!)).toBe(item.published_at);

    const forged = postItem({ ...post(5), created_at: '2026-01-01T00:00:00.000Z' }, 'src', new Date().toISOString());
    expect(forged.date_evidence).toMatchObject({ verified: false, conflict: true });
  });

  it('admits substantive short posts but never queues posts for web refetch', () => {
    const options = SourceOptionsSchema.parse({});
    const item = (value: string, overrides: Partial<XPost> = {}) => postItem(post(5, { text: value, ...overrides }), 'src', new Date().toISOString());
    expect(evaluateContent(item('Shipped streaming tool calls in our MCP server today.'), options, 'UTC')).toEqual({ status: 'ready', reason: 'ready' });
    expect(evaluateContent(item('Big news https://example.com/very/long/link/that/does/not/count'), options, 'UTC')).toEqual({ status: 'review', reason: 'body_invalid' });
    expect(evaluateContent(item('', { media: [{ kind: 'video', url: 'https://video.twimg.com/v.mp4' }] }), options, 'UTC').status).toBe('review');
    const unverified = { ...item(text), date_evidence: { verified: false } };
    expect(evaluateContent(unverified, options, 'UTC')).toEqual({ status: 'review', reason: 'date_unknown' });
  });
});

describe('Python worker runner', () => {
  it('finds the Windows virtualenv and never falls back to the Store python3 stub', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openlore-py-'));
    expect(resolvePythonPath(dir, 'win32')).toBe('python');
    expect(resolvePythonPath(dir, 'linux')).toBe('python3');
    fs.mkdirSync(path.join(dir, '.venv', 'Scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.venv', 'Scripts', 'python.exe'), '');
    expect(resolvePythonPath(dir, 'win32')).toBe(path.join(dir, '.venv', 'Scripts', 'python.exe'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passes proxy settings but not control-plane secrets, and masks credentials in diagnostics', () => {
    const env = workerEnv({ Path: '/bin', HTTPS_PROXY: 'http://proxy:1', OPENAI_API_KEY: 'sk-x', GITHUB_TOKEN: 'ghp' }, '/src');
    expect(env).toMatchObject({ Path: '/bin', HTTPS_PROXY: 'http://proxy:1', PYTHONPATH: '/src', TWS_TELEMETRY: '0' });
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    const leaked = redactDiagnostics(`cookies={"auth_token": "${'a'.repeat(40)}", "ct0": "abc"} token=xyz`);
    expect(leaked).not.toMatch(/a{40}|abc|xyz/);
  });

  const venv = path.resolve(__dirname, '../../../workers/python/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  it.skipIf(!fs.existsSync(venv))('reports a missing X session through the real worker without network access', async () => {
    const response = await new PythonWorkerRunner().run({
      protocol_version: 1,
      job_id: 'job-real',
      operation: 'collect_x_user',
      handle: 'builder',
      accounts_db: path.join(os.tmpdir(), `openlore-no-session-${Date.now()}.db`),
      state: { user_id: null, newest_id: null, pending: null },
      budget: { max_pages: 1, deadline_seconds: 5 },
    }, 20000);
    expect(response).toMatchObject({ job_id: 'job-real', status: 'failed', error: { code: 'x_no_account', retryable: false } });
  });
});

describe('X source collection', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openlore-x-test-'));
  beforeAll(async () => {
    process.env.OPENLORE_DATA_DIR = dataDir;
    initDatabase();
    await sourcesService.saveSource({ id: 'x', name: 'Builder', url: 'https://twitter.com/builder/', capability_id: 'x_user' });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => {
    getSqliteDatabase().close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('normalizes the profile URL and sizes worker requests from the request limit', async () => {
    expect((await sourcesService.getSource('x'))?.url).toBe('https://x.com/builder');
    await expect(sourcesService.saveSource({ name: 'Bad', url: 'https://x.com/search', capability_id: 'x_user' })).rejects.toThrow(/X 账号主页/);
    const run = vi.spyOn(pythonWorkerRunner, 'run').mockResolvedValue(workerResult([post(5)], { user_id: '1', newest_id: '1', pending: null }) as any);
    const preview = await collectionService.previewSource('x');
    expect(preview.items[0].issues).toContain('ready');
    expect(run.mock.calls[0][0]).toMatchObject({ operation: 'collect_x_user', handle: 'builder', budget: { max_pages: 1 }, state: { newest_id: null } });
    expect(run.mock.calls[0][1]).toBe(70_000);
    const adapter = new XUserCollectorAdapter();
    run.mockResolvedValue({ protocol_version: 1, job_id: 'j', status: 'success', issues: [], data: { posts: 'nope' } } as any);
    const invalid = await adapter.collect({
      run_id: 'r', source_id: 'x', source_revision: 'v', capability_id: 'x_user', operation: 'discover',
      target: { url: 'https://x.com/builder' }, scope: { limit: 100 }, options: {}, budget: { timeout_seconds: 20, max_requests: 10 },
    });
    expect(invalid).toMatchObject({ status: 'failed', errors: [{ code: 'invalid_worker_output' }] });
    expect(run.mock.calls[1][0]).toMatchObject({ budget: { max_pages: 3 } });
  });

  it('is idempotent across polls, keeps the checkpoint and never fetches x.com pages', async () => {
    const webPage = collectorRegistry.get('web_page')!;
    const refetch = vi.spyOn(webPage, 'collect');
    // A date that disagrees with the post ID must go to review, not to a web refetch of x.com.
    const posts = [post(5), post(6, { text: 'too short' }), post(7, { created_at: minutesAgo(600).toISOString() })];
    const run = vi.spyOn(pythonWorkerRunner, 'run').mockImplementation(async () => workerResult(posts, { user_id: '1', newest_id: posts[0].id, pending: null }) as any);
    for (let i = 0; i < 10; i++) await collectionService.discoverSource('x');
    const db = getSqliteDatabase();
    expect(run).toHaveBeenCalledTimes(10);
    expect(run.mock.calls[1][0]).toMatchObject({ state: { user_id: '1', newest_id: posts[0].id } });
    expect(db.prepare("SELECT status, reason FROM collection_candidates WHERE source_id='x' ORDER BY reason").all()).toEqual([
      { status: 'review', reason: 'body_invalid' },
      { status: 'review', reason: 'date_conflict' },
      { status: 'ready', reason: 'ready' },
    ]);
    expect(db.prepare('SELECT canonical_url, author FROM articles').all()).toEqual([
      { canonical_url: `https://x.com/i/status/${posts[0].id}`, author: 'Builder (@builder)' },
    ]);
    expect(db.prepare("SELECT count(*) n FROM source_items WHERE source_id='x'").get()).toEqual({ n: 1 });
    expect(refetch).not.toHaveBeenCalled();
  });

  it('stores partial results with their continuation state', async () => {
    const pending = { cursor: 'c2', top_id: post(1).id, stop_id: post(5).id };
    vi.spyOn(pythonWorkerRunner, 'run').mockResolvedValue(workerResult([post(1)], { user_id: '1', newest_id: post(5).id, pending }, 'partial') as any);
    const result = await collectionService.discoverSource('x');
    expect(result.status).toBe('partial');
    expect(result.stats.items_new).toBe(1);
    const state = getSqliteDatabase().prepare("SELECT state_json FROM source_states WHERE source_id='x'").get() as { state_json: string };
    expect(JSON.parse(state.state_json).pending).toEqual(pending);
  });

  it('records a rate-limit cooldown beside the unadvanced checkpoint and honors it everywhere', async () => {
    const db = getSqliteDatabase();
    const before = JSON.parse((db.prepare("SELECT state_json FROM source_states WHERE source_id='x'").get() as { state_json: string }).state_json);
    const run = vi.spyOn(pythonWorkerRunner, 'run').mockResolvedValue({
      protocol_version: 1, job_id: 'j', status: 'failed', issues: [], data: null,
      error: { code: 'x_rate_limited', message: 'X 会话限流或被占用，约 10 分钟后重试', retryable: true, retry_after_seconds: 600 },
    });
    const limited = await collectionService.discoverSource('x');
    expect(limited.errors[0]).toMatchObject({ code: 'x_rate_limited', retry_after_seconds: 600 });
    const saved = JSON.parse((db.prepare("SELECT state_json FROM source_states WHERE source_id='x'").get() as { state_json: string }).state_json);
    expect(saved).toMatchObject(before);
    expect(Date.parse(saved.cooldown_until) - Date.now()).toBeGreaterThan(590_000);
    expect((await sourcesService.getSource('x'))?.last_error).toContain('限流');

    expect((await collectionService.discoverSource('x')).errors[0].code).toBe('cooldown');
    expect((await collectionService.previewSource('x')).errors[0].code).toBe('cooldown');
    vi.spyOn(sourcesService, 'listSources').mockResolvedValue([(await sourcesService.getSource('x'))!]);
    expect(await appScheduler.pollDueSources(true)).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);

    // After expiry the worker receives the original checkpoint, without the cooldown marker.
    db.prepare("UPDATE source_states SET state_json=json_set(state_json,'$.cooldown_until','2000-01-01T00:00:00Z') WHERE source_id='x'").run();
    run.mockResolvedValue(workerResult([], before) as any);
    expect((await collectionService.discoverSource('x')).status).toBe('success');
    expect(run.mock.calls[1][0]).toMatchObject({ state: before });
    expect(run.mock.calls[1][0]).not.toHaveProperty('state.cooldown_until');
  });

  it('keeps partial results and still enters cooldown when the rate limit hits mid-scan', async () => {
    const pending = { cursor: 'c9', top_id: post(1).id, stop_id: post(5).id };
    const run = vi.spyOn(pythonWorkerRunner, 'run').mockResolvedValue({
      ...workerResult([post(1)], { user_id: '1', newest_id: post(5).id, pending }, 'partial'),
      error: { code: 'x_rate_limited', message: '限流', retryable: true, retry_after_seconds: 120 },
    } as any);
    expect((await collectionService.discoverSource('x')).status).toBe('partial');
    const saved = JSON.parse((getSqliteDatabase().prepare("SELECT state_json FROM source_states WHERE source_id='x'").get() as { state_json: string }).state_json);
    expect(saved.pending).toEqual(pending);
    expect(Date.parse(saved.cooldown_until) - Date.now()).toBeGreaterThan(110_000);
    expect((await collectionService.discoverSource('x')).errors[0].code).toBe('cooldown');
    expect(run).toHaveBeenCalledTimes(1);
    getSqliteDatabase().prepare("UPDATE source_states SET state_json=json_set(state_json,'$.cooldown_until','2000-01-01T00:00:00Z') WHERE source_id='x'").run();
  });

  it('puts the source into cooldown when a preview is rate limited, without touching the checkpoint', async () => {
    const db = getSqliteDatabase();
    const stateOf = () => JSON.parse((db.prepare("SELECT state_json FROM source_states WHERE source_id='x'").get() as { state_json: string }).state_json);
    const { cooldown_until: _old, ...before } = stateOf();
    const run = vi.spyOn(pythonWorkerRunner, 'run').mockResolvedValue({
      protocol_version: 1, job_id: 'j', status: 'failed', issues: [], data: null,
      error: { code: 'x_rate_limited', message: 'X 会话限流或被占用，约 5 分钟后重试', retryable: true, retry_after_seconds: 300 },
    });
    expect((await collectionService.previewSource('x')).errors[0].code).toBe('x_rate_limited');
    const saved = stateOf();
    expect(saved).toMatchObject(before);
    expect(Date.parse(saved.cooldown_until) - Date.now()).toBeGreaterThan(290_000);
    expect((await collectionService.discoverSource('x')).errors[0].code).toBe('cooldown');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
