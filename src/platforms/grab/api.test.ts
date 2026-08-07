import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fetchDailyReport, fetchOrderDetail, formatTzOffset } from './api.js';
import { AuthError } from '../../core/types.js';
import type { GrabSession } from './auth.js';

test('IANA names map to offsets', () => {
  assert.equal(formatTzOffset('Asia/Ho_Chi_Minh'), '+07:00');
  assert.equal(formatTzOffset('Asia/Singapore'), '+08:00');
  assert.equal(formatTzOffset('UTC'), '+00:00');
});

test('raw offsets pass through', () => {
  assert.equal(formatTzOffset('+07:00'), '+07:00');
  assert.equal(formatTzOffset('-05:00'), '-05:00');
  assert.equal(formatTzOffset('+0800'), '+08:00'); // colon-less normalized
});

test('unrecognized timezone throws', () => {
  assert.throws(() => formatTzOffset('America/Nowhere'), /Unrecognized timezone/);
  assert.throws(() => formatTzOffset(''), /Unrecognized timezone/);
});

// ===== fetchOrderDetail =====

const session: GrabSession = { cookies: { hwToken: 'x' }, fetchedAt: 0 };

/** Answer successive requests with these exact bodies — bytes in, bytes out. The last one repeats. */
function respondWithEach(bodies: string[], status = 200) {
  let i = 0;
  return mock.method(globalThis, 'fetch', async () => new Response(bodies[Math.min(i++, bodies.length - 1)], {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

/** Answer the next request with this exact body. */
function respondWith(body: string, status = 200) {
  return respondWithEach([body], status);
}

test('the response body is handed back exactly as it arrived', async (t) => {
  t.after(() => mock.restoreAll());
  // Two things a parse-then-re-serialize destroys, both real and both from live
  // responses: Grab's encoder emits '&' as a six-character unicode escape, and
  // orderFlags is an int64 bitfield 131 away from the nearest double. The stored
  // payload is only worth having if it is the payload — nothing may re-encode it.
  const body = '{"order":{"orderID":"001-A","orderFlags":4035792627008804869,"n":"a \\u0026 b"}}';
  respondWith(body);

  const detail = await fetchOrderDetail(session, '001-A');
  assert.equal(detail.raw, body, 'byte for byte');
  assert.notEqual(JSON.stringify({ order: detail.order }), body, 'which re-serializing would not be');

  // And the parsed view keeps the value even though it cannot keep the bytes.
  assert.equal(detail.order.orderID, '001-A');
  assert.match(JSON.stringify(detail.order), /"orderFlags":4035792627008804869[,}]/);
});

test('a 200 that is not the expected document fails loudly', async (t) => {
  t.after(() => mock.restoreAll());

  respondWith('{"error":"nope"}');
  await assert.rejects(fetchOrderDetail(session, '001-A'), /has no order/);

  // Grab answers 200 with an HTML interstitial when it wants a human. That must not
  // surface as a SyntaxError carrying 8 KB of markup.
  respondWith('<!doctype html><html>…</html>');
  await assert.rejects(fetchOrderDetail(session, '001-A'), /is not JSON/);
});

test('401 is an AuthError, so the connector re-logs in instead of losing the order', async (t) => {
  t.after(() => mock.restoreAll());
  respondWith('', 401);
  await assert.rejects(fetchOrderDetail(session, '001-A'), (err: unknown) => {
    assert.ok(err instanceof AuthError);
    assert.equal(err.authState, 'expired');
    return true;
  });
});

// ===== fetchDailyReport =====

const DAY = { from: '2026-08-05', to: '2026-08-05' };
const TZ = 'Asia/Ho_Chi_Minh';

// Off a live daily-pagination response for 001578008445-C8C3KBJWGYE2JN. The same
// int64 bitfield the detail payload carries — the statement has one of its own.
const FLAGS = '4035788216077387780';
const FLAGS_ROUNDED = '4035788216077388000'; // what a plain resp.json() made of it

const statement = (id: string) =>
  `{"ID":"${id}","orderFlags":${FLAGS},"deliveryStatus":"COMPLETED","priceDisplay":"548.000"}`;

test("a statement's int64 survives the parse, so repo.ts can re-emit it", async (t) => {
  t.after(() => mock.restoreAll());
  // The daily report has no verbatim body to keep: it answers {"statements":[…]} and
  // orders.raw_json stores ONE element of that array. Fidelity therefore has to
  // survive the parse, and what proves it is the JSON.stringify repo.ts does next.
  const body = `{"statements":[${statement('001578008445-C8C3KBJWGYE2JN')}]}`;
  respondWith(body);

  const [row] = await fetchDailyReport(session, DAY, TZ);
  assert.match(JSON.stringify(row), new RegExp(`"orderFlags":${FLAGS}[,}]`), 'stringified for orders.raw_json');
  assert.doesNotMatch(JSON.stringify(row), new RegExp(FLAGS_ROUNDED));

  // Everything else still reads as an ordinary value — a fidelity fix that turned
  // fields into wrappers would break every consumer of the statement.
  assert.equal(row.ID, '001578008445-C8C3KBJWGYE2JN');
  assert.equal(row.deliveryStatus, 'COMPLETED');
  assert.equal(row.priceDisplay, '548.000');

  // What it is defended against, in one line: this is what resp.json() handed back.
  assert.match(JSON.stringify(JSON.parse(body).statements[0]), new RegExp(FLAGS_ROUNDED));
});

test('paging still walks every page, and a short page ends it', async (t) => {
  t.after(() => mock.restoreAll());
  const full = `{"statements":[${statement('A-1')},${statement('A-2')}]}`;
  const short = `{"statements":[${statement('A-3')}]}`;
  const fetchMock = respondWithEach([full, short, full]);

  const rows = await fetchDailyReport(session, DAY, TZ, 2);
  assert.deepEqual(rows.map(r => r.ID), ['A-1', 'A-2', 'A-3']);
  assert.equal(fetchMock.mock.callCount(), 2, 'the short page is the last page');
});

test('an explicit hasMore:false stops a full page from asking for another', async (t) => {
  t.after(() => mock.restoreAll());
  const fetchMock = respondWithEach([`{"statements":[${statement('A-1')},${statement('A-2')}],"hasMore":false}`]);

  assert.equal((await fetchDailyReport(session, DAY, TZ, 2)).length, 2);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('a daily report that is not JSON says so, rather than throwing markup', async (t) => {
  t.after(() => mock.restoreAll());
  // Same interstitial as the detail endpoint answers when Grab wants a human.
  respondWith('<!doctype html><html>…</html>');
  await assert.rejects(fetchDailyReport(session, DAY, TZ), /daily report response is not JSON/);

  // A 200 with no statements is not an error — it is an empty day.
  respondWith('{}');
  assert.deepEqual(await fetchDailyReport(session, DAY, TZ), []);
});

test('401 on the report is an AuthError too, so the run re-logs in once', async (t) => {
  t.after(() => mock.restoreAll());
  respondWith('', 401);
  await assert.rejects(fetchDailyReport(session, DAY, TZ), (err: unknown) => {
    assert.ok(err instanceof AuthError);
    assert.equal(err.authState, 'expired');
    return true;
  });
});
