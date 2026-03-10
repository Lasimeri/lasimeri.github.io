// signaling.js — GitHub Issues API signaling with ETag polling

import { encrypt, decrypt } from './crypto.js';

const OWNER = 'Lasimeri';
const REPO = 'encrypted-sea';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

// Obfuscated PAT — split and reversed to avoid plain-text scraping
const _t = [
  '17dVu', 'VJRCEoY', 'CCQICDX', 'QHzNuUq',
  '0OrSFTG', 'yn0mL5f', 'gXj6PDl', 'u2jK98U',
  'G_5EgE4', 'ORVSjH1', '4A0YaUz', '11BTZT3'
].reverse().join('');
const _p = `github_pat_${_t}`;

function headers() {
  return {
    'Authorization': `Bearer ${_p}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

export async function createRoom(roomId, sdpOffer, roomKey) {
  const encryptedBody = await encrypt(sdpOffer, roomKey);
  const res = await fetch(`${API}/issues`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      title: `[room:${roomId}]`,
      body: encryptedBody
    })
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Failed to create issue: ${res.status} ${err}`);
  }
  const data = await res.json();
  return data.number;
}

export async function postAnswer(issueNumber, sdpAnswer, roomKey) {
  const encryptedBody = await encrypt(sdpAnswer, roomKey);
  const res = await fetch(`${API}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ body: encryptedBody })
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Failed to post answer: ${res.status} ${err}`);
  }
}

export async function pollForAnswer(issueNumber, roomKey, signal) {
  let etag = null;
  while (!signal?.aborted) {
    const h = headers();
    if (etag) h['If-None-Match'] = etag;

    const res = await fetch(
      `${API}/issues/${issueNumber}/comments?per_page=1`,
      { headers: h }
    );

    etag = res.headers.get('ETag');

    if (res.status === 304) {
      await delay(2000);
      continue;
    }

    if (!res.ok) throw new Error(`Poll comments failed: ${res.status}`);

    const comments = await res.json();
    if (comments.length > 0) {
      const sdpAnswer = await decrypt(comments[0].body, roomKey);
      return sdpAnswer;
    }

    await delay(2000);
  }
  throw new Error('Polling aborted');
}

export async function pollForRoom(roomId, roomKey, signal) {
  let etag = null;
  const target = `[room:${roomId}]`;

  while (!signal?.aborted) {
    const h = headers();
    if (etag) h['If-None-Match'] = etag;

    const res = await fetch(
      `${API}/issues?state=open&per_page=50&sort=created&direction=desc`,
      { headers: h }
    );

    etag = res.headers.get('ETag');

    if (res.status === 304) {
      await delay(2000);
      continue;
    }

    if (!res.ok) throw new Error(`Poll issues failed: ${res.status}`);

    const issues = await res.json();
    const issue = issues.find(i => i.title === target);
    if (issue) {
      const sdpOffer = await decrypt(issue.body, roomKey);
      return { issueNumber: issue.number, sdpOffer };
    }

    await delay(2000);
  }
  throw new Error('Polling aborted');
}

export async function closeRoom(issueNumber) {
  await fetch(`${API}/issues/${issueNumber}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({ state: 'closed' })
  });
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}
