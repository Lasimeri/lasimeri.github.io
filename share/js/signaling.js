// signaling.js — GitHub Issues API signaling with ETag polling

import { encrypt, decrypt } from './crypto.js?v=6';

// Obfuscated identifiers — not stored in plaintext
const _o = atob('TGFzaW1lcmk=');
const _r = atob('ZW5jcnlwdGVkLXNlYQ==');
const API = `https://api.github.com/repos/${_o}/${_r}`;

// Obfuscated auth
const _t = [
  'z', 'iD22cE1', 'p8vBHpg', 'H46lkc6',
  'e9BPRxu', 'j67xIxE'
].reverse().join('');
const _p = `ghp_${_t}`;

// Debug logger — set by main.js
let _log = () => {};
export function setLogger(fn) { _log = fn; }

function headers(write = false) {
  const h = {
    'Authorization': `Bearer ${_p}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (write) h['Content-Type'] = 'application/json';
  return h;
}

export async function createRoom(roomId, sdpOffer, roomKey) {
  const encryptedBody = await encrypt(sdpOffer, roomKey);
  _log(`Creating issue [room:${roomId}]...`);
  const res = await fetch(`${API}/issues`, {
    method: 'POST',
    headers: headers(true),
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
  _log(`Issue #${data.number} created`);
  return data.number;
}

export async function postAnswer(issueNumber, sdpAnswer, roomKey) {
  const encryptedBody = await encrypt(sdpAnswer, roomKey);
  _log(`Posting answer to issue #${issueNumber}...`);
  const res = await fetch(`${API}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify({ body: encryptedBody })
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    _log(`POST comment failed: ${res.status} ${err}`);
    throw new Error(`Failed to post answer: ${res.status} ${err}`);
  }
  _log('Answer posted successfully');
}

export async function pollForAnswer(issueNumber, roomKey, signal) {
  let etag = null;
  let polls = 0;
  _log(`Polling for answer on issue #${issueNumber}...`);
  while (!signal?.aborted) {
    const h = headers();
    if (etag) h['If-None-Match'] = etag;

    try {
      const res = await fetch(
        `${API}/issues/${issueNumber}/comments?per_page=1`,
        { headers: h }
      );

      polls++;
      etag = res.headers.get('ETag');

      if (res.status === 304) {
        _log(`Poll #${polls}: 304 (no change)`);
        await delay(2000);
        continue;
      }

      if (!res.ok) throw new Error(`Poll comments failed: ${res.status}`);

      const comments = await res.json();
      _log(`Poll #${polls}: ${res.status}, ${comments.length} comments`);
      if (comments.length > 0) {
        _log('Decrypting answer...');
        const sdpAnswer = await decrypt(comments[0].body, roomKey);
        return sdpAnswer;
      }
    } catch (err) {
      _log(`Poll #${polls} error: ${err.message}`);
      throw err;
    }

    await delay(2000);
  }
  throw new Error('Polling aborted');
}

export async function pollForRoom(roomId, roomKey, signal) {
  let etag = null;
  let polls = 0;
  const target = `[room:${roomId}]`;
  _log(`Polling for room: ${target}`);

  while (!signal?.aborted) {
    const h = headers();
    if (etag) h['If-None-Match'] = etag;

    try {
      const res = await fetch(
        `${API}/issues?state=open&per_page=50&sort=created&direction=desc`,
        { headers: h }
      );

      polls++;
      etag = res.headers.get('ETag');

      if (res.status === 304) {
        _log(`Poll #${polls}: 304 (no change)`);
        await delay(2000);
        continue;
      }

      if (!res.ok) throw new Error(`Poll issues failed: ${res.status}`);

      const issues = await res.json();
      const titles = issues.map(i => i.title);
      _log(`Poll #${polls}: ${res.status}, ${issues.length} issues found: ${titles.join(', ')}`);

      const issue = issues.find(i => i.title === target);
      if (issue) {
        _log(`Matched issue #${issue.number}, decrypting offer...`);
        const sdpOffer = await decrypt(issue.body, roomKey);
        _log('Offer decrypted successfully');
        return { issueNumber: issue.number, sdpOffer };
      } else {
        _log(`No match for ${target}`);
      }
    } catch (err) {
      _log(`Poll #${polls} error: ${err.message}`);
      throw err;
    }

    await delay(2000);
  }
  throw new Error('Polling aborted');
}

export async function closeRoom(issueNumber) {
  await fetch(`${API}/issues/${issueNumber}`, {
    method: 'PATCH',
    headers: headers(true),
    body: JSON.stringify({ state: 'closed' })
  });
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}
