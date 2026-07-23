#!/usr/bin/env node
/**
 * 경쟁사 이벤트/프로모션 신호 수집기.
 *
 *   node collect.js              오늘자 수집
 *   node collect.js --all        seen 기록 무시하고 전량 재수집
 *   node collect.js --only=id    특정 경쟁사만
 *
 * 출력:
 *   data/raw/YYYY-MM-DD.json   이번 실행에서 처음 본 항목만 (Claude가 읽고 분류)
 *   data/seen.json             중복 방지용 지문 저장소
 *
 * 외부 의존성 없음 (Node 18+ 내장 fetch 사용).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(ROOT, 'config', 'competitors.json');
const DATA = path.join(ROOT, 'data');
const RAW = path.join(DATA, 'raw');
const SEEN = path.join(DATA, 'seen.json');

const argv = process.argv.slice(2);
const FORCE_ALL = argv.includes('--all');
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('  !', ...a);

/* ---------- 유틸 ---------- */

const today = () => new Date().toISOString().slice(0, 10);

const fingerprint = (item) =>
  crypto
    .createHash('sha1')
    .update([item.competitor_id, item.source, item.external_id].join('|'))
    .digest('hex')
    .slice(0, 16);

function readJson(file, fallback) {
  try {
    // 윈도우 편집기가 붙이는 BOM 을 제거하고 파싱한다.
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

async function get(url, { json = false } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return json ? res.json() : res.text();
}

const stripTags = (html) =>
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/* ---------- 수집기: App Store ---------- */
/* iTunes Lookup API — 공개, 키 불필요. 업데이트 노트가 이벤트 공지를 가장 많이 담고 있음. */

async function collectAppStore(c) {
  if (!c.appstore_id) return [];
  const country = c.appstore_country || 'kr';
  const url = `https://itunes.apple.com/lookup?id=${c.appstore_id}&country=${country}&lang=ko_kr`;
  const data = await get(url, { json: true });
  const app = data.results?.[0];
  if (!app) throw new Error(`App Store에서 id=${c.appstore_id} 를 찾지 못함`);

  return [
    {
      competitor_id: c.id,
      source: 'appstore_release',
      external_id: `v${app.version}`,
      title: `iOS ${app.version} 업데이트`,
      body: app.releaseNotes || '(릴리스 노트 없음)',
      url: app.trackViewUrl,
      published_at: app.currentVersionReleaseDate?.slice(0, 10) || null,
    },
  ];
}

/* ---------- 수집기: App Store 인앱 상품 가격 ---------- */
/* lookup API 는 인앱 상품을 주지 않는다. 대신 앱 상세 웹페이지에 상위 10개 상품이
   이름+가격 쌍으로 직렬화돼 들어 있다. 가격이나 구성이 바뀌면 프로모션 신호다. */

const IAP_STATE = path.join(DATA, 'iap-state.json');

// "textPairs":[["이름","₩2,800"], ...] 를 대괄호 짝을 세어 잘라낸다.
function extractTextPairs(html) {
  const key = '"textPairs":';
  let from = 0;
  while (true) {
    const i = html.indexOf(key, from);
    if (i === -1) return null;
    const start = html.indexOf('[', i);
    if (start === -1) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = start; j < html.length && j < start + 20000; j++) {
      const ch = html[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          try {
            const arr = JSON.parse(html.slice(start, j + 1));
            // [이름, 가격] 쌍의 배열인지 확인한다.
            if (Array.isArray(arr) && arr.length && arr.every((p) => Array.isArray(p) && p.length === 2))
              return arr;
          } catch {
            /* 다음 후보로 */
          }
          from = j;
          break;
        }
      }
    }
    if (from <= i) return null;
  }
}

async function collectAppStoreIap(c) {
  if (!c.appstore_id) return [];
  const country = c.appstore_country || 'kr';
  const url = `https://apps.apple.com/${country}/app/id${c.appstore_id}`;
  const html = await get(url);
  const pairs = extractTextPairs(html);
  if (!pairs) throw new Error('앱 상세 페이지에서 인앱 상품 목록을 찾지 못함');

  // 가격은 전각 원화(￦)로 오는 경우가 있어 통일한다.
  const list = pairs.map(([n, p]) => `${n} — ${String(p).replace(/￦/g, '₩')}`);
  const state = readJson(IAP_STATE, {});
  const prev = state[c.id] || null;
  state[c.id] = list;
  writeJson(IAP_STATE, state);

  if (prev && prev.join('|') === list.join('|')) return []; // 변동 없음

  let body = `App Store 노출 상위 인앱 상품 (${list.length}종):\n- ${list.join('\n- ')}`;
  if (prev) {
    const added = list.filter((x) => !prev.includes(x));
    const removed = prev.filter((x) => !list.includes(x));
    body =
      `인앱 상품 구성이 바뀌었습니다.\n` +
      (added.length ? `\n[추가]\n- ${added.join('\n- ')}` : '') +
      (removed.length ? `\n[삭제]\n- ${removed.join('\n- ')}` : '') +
      `\n\n[현재 전체]\n- ${list.join('\n- ')}`;
  }

  return [
    {
      competitor_id: c.id,
      source: 'appstore_iap',
      external_id: `iap:${crypto.createHash('sha1').update(list.join('|')).digest('hex').slice(0, 12)}`,
      title: prev ? '인앱 상품 구성·가격 변경' : '인앱 상품 구성 (최초 수집)',
      body,
      url,
      published_at: today(),
    },
  ];
}

/* ---------- 수집기: Google Play ---------- */
/* 공식 API가 없어 상세 페이지의 AF_initDataCallback 페이로드를 파싱한다.
   구글이 인덱스 구조를 바꾸면 깨질 수 있으므로 경로 조회 → 휴리스틱 순으로 폴백한다. */

function playPayloads(html) {
  const out = [];
  const re = /AF_initDataCallback\((\{.*?\})\);<\/script>/gs;
  let m;
  while ((m = re.exec(html))) {
    const dataMatch = /data:(\[.*?\])(?:,\s*sideChannel|\}$)/s.exec(m[1]);
    if (!dataMatch) continue;
    try {
      out.push(JSON.parse(dataMatch[1]));
    } catch {
      /* 파싱 불가한 블록은 건너뜀 */
    }
  }
  return out;
}

const at = (obj, pathArr) => pathArr.reduce((v, k) => (v == null ? v : v[k]), obj);

function findRecentChanges(payloads) {
  // 1순위: google-play-scraper가 쓰는 알려진 경로.
  const KNOWN = [
    [1, 2, 144, 1, 1],
    [1, 2, 144, 1, 0],
  ];
  for (const p of payloads) {
    for (const k of KNOWN) {
      const v = at(p, k);
      if (typeof v === 'string' && v.trim().length > 10) return v;
    }
  }
  // 2순위: 릴리스 노트는 <br> 를 포함한 긴 문자열인 경우가 대부분.
  let best = null;
  const walk = (v, depth) => {
    if (depth > 14 || v == null) return;
    if (typeof v === 'string') {
      if (/<br\s*\/?>/i.test(v) && v.length > 40 && v.length < 4000) {
        if (!best || v.length > best.length) best = v;
      }
      return;
    }
    if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
  };
  payloads.forEach((p) => walk(p, 0));
  return best;
}

function findVersion(payloads) {
  const KNOWN = [
    [1, 2, 140, 0, 0, 0],
    [1, 2, 140, 0, 0],
  ];
  for (const p of payloads) {
    for (const k of KNOWN) {
      const v = at(p, k);
      if (typeof v === 'string' && /^[\d.]+/.test(v)) return v;
    }
  }
  return null;
}

// 최종 업데이트 시각(epoch 초). 없으면 null — 수집일로 대체하지 않는다.
function findUpdated(payloads) {
  const KNOWN = [
    [1, 2, 145, 0, 1, 0],
    [1, 2, 145, 0, 0],
  ];
  for (const p of payloads) {
    for (const k of KNOWN) {
      const v = at(p, k);
      if (typeof v === 'number' && v > 1e9 && v < 4e9) return v;
    }
  }
  return null;
}

async function collectPlay(c) {
  if (!c.play_package) return [];
  const url = `https://play.google.com/store/apps/details?id=${encodeURIComponent(
    c.play_package
  )}&hl=ko&gl=KR`;
  const html = await get(url);
  const payloads = playPayloads(html);
  const notes = findRecentChanges(payloads);
  const version = findVersion(payloads);
  const updated = findUpdated(payloads);

  if (!notes) {
    throw new Error(
      'Play 상세 페이지에서 릴리스 노트를 추출하지 못함 (구글 페이지 구조 변경 가능성)'
    );
  }
  const text = stripTags(notes);
  return [
    {
      competitor_id: c.id,
      source: 'play_release',
      external_id: version ? `v${version}` : `notes:${crypto.createHash('sha1').update(text).digest('hex').slice(0, 12)}`,
      title: `Android ${version || ''} 업데이트`.trim(),
      body: text,
      url,
      // 실제 업데이트 날짜를 못 읽으면 null 로 둔다 (수집일을 릴리스일로 위장하지 않는다).
      published_at: updated ? new Date(updated * 1000).toISOString().slice(0, 10) : null,
    },
  ];
}

/* ---------- 수집기: RSS / Atom (유튜브 포함) ---------- */

function parseFeed(xml, { competitor_id, source, limit = 15 }) {
  const items = [];
  const blocks = xml.match(/<(entry|item)\b[\s\S]*?<\/\1>/g) || [];
  for (const b of blocks.slice(0, limit)) {
    const pick = (tag) => {
      const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(b);
      if (!m) return null;
      return stripTags(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
    };
    const linkHref = /<link[^>]*href="([^"]+)"/i.exec(b)?.[1];
    const title = pick('title');
    if (!title) continue;
    const url = linkHref || pick('link');
    items.push({
      competitor_id,
      source,
      external_id: pick('id') || pick('guid') || url || title,
      title,
      body: pick('media:description') || pick('description') || pick('summary') || pick('content') || '',
      url,
      published_at: (pick('published') || pick('pubDate') || pick('updated') || '').slice(0, 10) || null,
    });
  }
  return items;
}

async function collectYouTube(c) {
  if (!c.youtube_channel_id) return [];
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${c.youtube_channel_id}`;
  const xml = await get(url);
  return parseFeed(xml, { competitor_id: c.id, source: 'youtube' });
}

async function collectFeeds(c) {
  const out = [];
  for (const feed of c.feeds || []) {
    try {
      const xml = await get(feed);
      out.push(...parseFeed(xml, { competitor_id: c.id, source: 'feed' }));
    } catch (e) {
      warn(`feed 실패 ${feed}: ${e.message}`);
    }
  }
  return out;
}

/* ---------- 수집기: 공지 게시판 ---------- */
/* 링크 목록을 항목으로 취급한다. 게시판형 페이지 대부분에서 동작하며,
   새 글이 올라오면 새 href 가 생기므로 자연스럽게 신규 감지가 된다. */

async function collectNotice(c) {
  if (!c.notice_url) return [];
  const html = await get(c.notice_url);
  const base = new URL(c.notice_url);
  const pattern = c.notice_link_pattern ? new RegExp(c.notice_link_pattern) : null;

  const seenHref = new Set();
  const items = [];
  const re = /<a\b[^>]*href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const text = stripTags(m[2]).replace(/\s+/g, ' ').trim();
    if (!text || text.length < 6 || text.length > 200) continue;
    if (pattern && !pattern.test(href)) continue;
    if (!pattern && !/(notice|news|event|board|post|article|view|\/\d{3,})/i.test(href)) continue;

    let abs;
    try {
      abs = new URL(href, base).toString();
    } catch {
      continue;
    }
    if (seenHref.has(abs)) continue;
    seenHref.add(abs);
    items.push({
      competitor_id: c.id,
      source: 'notice',
      external_id: abs,
      title: text,
      body: '',
      url: abs,
      published_at: null,
    });
    if (items.length >= 40) break;
  }
  if (!items.length) throw new Error('공지 링크를 하나도 추출하지 못함 (notice_link_pattern 지정 필요)');
  return items;
}

/* ---------- 오케스트레이션 ---------- */

const COLLECTORS = [
  ['appstore', collectAppStore],
  ['appstore_iap', collectAppStoreIap],
  ['play', collectPlay],
  ['youtube', collectYouTube],
  ['feeds', collectFeeds],
  ['notice', collectNotice],
];

async function main() {
  const cfg = readJson(CONFIG, null);
  if (!cfg) {
    console.error(`설정 파일을 읽지 못했습니다: ${CONFIG}`);
    process.exit(1);
  }
  const competitors = cfg.competitors.filter(
    (c) => !c.id.startsWith('example-') && (!ONLY || c.id === ONLY)
  );
  if (!competitors.length) {
    console.error('수집할 경쟁사가 없습니다. config/competitors.json 을 먼저 채우세요.');
    process.exit(1);
  }

  const seen = FORCE_ALL ? {} : readJson(SEEN, {});
  const fresh = [];
  const errors = [];
  const stamp = new Date().toISOString();

  for (const c of competitors) {
    log(`\n▸ ${c.name} (${c.id})`);
    for (const [label, fn] of COLLECTORS) {
      let items;
      try {
        items = await fn(c);
      } catch (e) {
        warn(`${label}: ${e.message}`);
        errors.push({ competitor_id: c.id, collector: label, error: e.message });
        continue;
      }
      if (!items.length) continue;
      let added = 0;
      for (const it of items) {
        const fp = fingerprint(it);
        if (seen[fp]) continue;
        seen[fp] = stamp;
        fresh.push({ ...it, competitor_name: c.name, fetched_at: stamp, fingerprint: fp });
        added++;
      }
      log(`  ${label}: ${items.length}건 중 신규 ${added}건`);
    }
  }

  const outFile = path.join(RAW, `${today()}.json`);
  const prev = readJson(outFile, { items: [], errors: [] });
  writeJson(outFile, {
    date: today(),
    collected_at: stamp,
    items: [...prev.items, ...fresh],
    errors: [...(prev.errors || []), ...errors],
  });
  writeJson(SEEN, seen);

  log(`\n신규 ${fresh.length}건 → ${path.relative(ROOT, outFile)}`);
  if (errors.length) log(`실패한 수집기 ${errors.length}건 (위 로그 참고)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
