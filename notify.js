#!/usr/bin/env node
/**
 * 슬랙 Incoming Webhook 으로 리포트를 전송한다.
 *
 *   echo "메시지" | node notify.js
 *   node notify.js "메시지"
 *
 * Webhook URL 은 아래 순서로 찾는다:
 *   1. 환경변수 SLACK_WEBHOOK_URL
 *   2. config/slack-webhook.txt 파일 (한 줄)
 *
 * 사람 계정이 아니라 앱(봇) 이름으로 게시되므로, 자동 생성물임이 분명해진다.
 * 성공하면 exit 0, 실패하면 stderr 에 이유를 적고 exit 1 — 조용히 실패하지 않는다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function webhookUrl() {
  if (process.env.SLACK_WEBHOOK_URL) return process.env.SLACK_WEBHOOK_URL.trim();
  const file = path.join(ROOT, 'config', 'slack-webhook.txt');
  if (fs.existsSync(file)) {
    const v = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
    if (v) return v;
  }
  return null;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const url = webhookUrl();
if (!url) {
  console.error(
    'SLACK_WEBHOOK_URL 이 없습니다. 환경변수로 넘기거나 config/slack-webhook.txt 에 넣으세요.'
  );
  process.exit(1);
}
if (!/^https:\/\/hooks\.slack\.com\/services\//.test(url)) {
  console.error('Webhook URL 형식이 아닙니다: https://hooks.slack.com/services/... 여야 합니다.');
  process.exit(1);
}

const text = (process.argv[2] || readStdin()).trim();
if (!text) {
  console.error('보낼 메시지가 비어 있습니다.');
  process.exit(1);
}

const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  // mrkdwn 을 켜 두면 *굵게* _기울임_ <링크|텍스트> 가 그대로 렌더된다.
  body: JSON.stringify({ text, mrkdwn: true }),
});

const body = await res.text();
if (!res.ok || body.trim() !== 'ok') {
  console.error(`슬랙 전송 실패: HTTP ${res.status} ${body}`);
  process.exit(1);
}
console.log('슬랙 전송 완료');
