#!/usr/bin/env node
/**
 * data/events.json + config/competitors.json → dashboard.html
 *
 *   node build-dashboard.js [--date=YYYY-MM-DD]
 *
 * 템플릿(src/template.html)의 /*__DATA__* / 자리에 JSON 을 끼워 넣기만 한다.
 * 렌더링은 전부 브라우저에서 하므로 필터·정렬은 빌드 없이 동작한다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));

const argv = process.argv.slice(2);
const dateArg = (argv.find((a) => a.startsWith('--date=')) || '').split('=')[1];
const today = dateArg || new Date().toISOString().slice(0, 10);

const cfg = readJson(path.join(ROOT, 'config', 'competitors.json'));
const store = readJson(path.join(ROOT, 'data', 'events.json'));

const competitors = Object.fromEntries(
  cfg.competitors.filter((c) => !c.id.startsWith('example-')).map((c) => [c.id, c.name])
);

const VALID_TYPES = new Set(['event', 'promo', 'update', 'collab', 'marketing']);
const REQUIRED = ['id', 'competitor_id', 'type', 'title', 'summary', 'starts_on', 'detected_on'];

// 검증: 잘못된 항목은 조용히 렌더하지 않고 빌드를 실패시킨다.
const problems = [];
const seenIds = new Set();
for (const e of store.events) {
  const where = e.id || JSON.stringify(e).slice(0, 60);
  for (const f of REQUIRED) if (!e[f]) problems.push(`${where}: 필수 필드 누락 '${f}'`);
  if (e.type && !VALID_TYPES.has(e.type)) problems.push(`${where}: 알 수 없는 type '${e.type}'`);
  if (e.competitor_id && !competitors[e.competitor_id])
    problems.push(`${where}: competitors.json 에 없는 competitor_id '${e.competitor_id}'`);
  if (e.starts_on && e.ends_on && e.ends_on < e.starts_on)
    problems.push(`${where}: ends_on 이 starts_on 보다 빠름`);
  if (e.id && seenIds.has(e.id)) problems.push(`${where}: 중복 id`);
  if (e.id) seenIds.add(e.id);
}
if (problems.length) {
  console.error('events.json 검증 실패:');
  problems.forEach((p) => console.error('  - ' + p));
  process.exit(1);
}

// 가장 최근 수집 시각을 raw 디렉터리에서 읽어 헤더에 표시한다.
let collectedAt = today;
try {
  const files = fs.readdirSync(path.join(ROOT, 'data', 'raw')).filter((f) => f.endsWith('.json'));
  if (files.length) collectedAt = files.sort().at(-1).replace('.json', '');
} catch {
  /* raw 가 아직 없으면 today 를 쓴다 */
}

const payload = {
  today,
  collected_at: collectedAt,
  competitors,
  events: store.events,
};

const template = fs.readFileSync(path.join(ROOT, 'src', 'template.html'), 'utf8');
const json = JSON.stringify(payload).replace(/</g, '\\u003c');
const html = template.replace('/*__DATA__*/ null', json);
if (html === template) {
  console.error('템플릿에서 데이터 자리표시자를 찾지 못했습니다.');
  process.exit(1);
}

const out = path.join(ROOT, 'dashboard.html');
fs.writeFileSync(out, html, 'utf8');
console.log(
  `${out}\n  경쟁사 ${Object.keys(competitors).length}곳 · 이벤트 ${store.events.length}건 · 기준일 ${today}`
);
