// signaling.js — GitHub Issues API signaling with ETag polling

import { encrypt, decrypt } from './crypto.js?v=12';
import { unlock } from './secrets.js?v=12';

// AES-256-GCM encrypted — decrypted only in RAM at runtime
const _ENC_OWNER = 'ac4f46e60fb97322e35899fb4919d348ce1f997ae2d85c6a02533e88b5fd2951fcb36597';
const _ENC_REPO = 'e12cfcf665925f2bb51a1ba370c6a36a5ae83083cf04f1391f12f2f12cca784b907555138b72776927';
const _ENC_PAT = 'f94019dd5e3dbe2225027060079bc66d780805d9e3e60ad53aab7974db8604f0c0d6e10638b6f85cabe1815cde44291ed833f953e83b0acce9787a74eb285139b4e2fce3';

// Decrypted at init — only exists in RAM
let _api = null;
let _pat = null;

async function init() {
  if (_api) return;
  const [owner, repo, pat] = await Promise.all([
    unlock(_ENC_OWNER),
    unlock(_ENC_REPO),
    unlock(_ENC_PAT)
  ]);
  _api = `https://api.github.com/repos/${owner}/${repo}`;
  _pat = pat;
}

// Debug logger — set by main.js
let _log = () => {};
export function setLogger(fn) { _log = fn; }

function headers(write = false) {
  const h = {
    'Authorization': `Bearer ${_pat}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (write) h['Content-Type'] = 'application/json';
  return h;
}

export async function createRoom(roomId, sdpOffer, roomKey) {
  await init();
  const encryptedBody = await encrypt(sdpOffer, roomKey);
  _log(`Creating issue [room:${roomId}]...`);
  const res = await fetch(`${_api}/issues`, {
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
  await init();
  const encryptedBody = await encrypt(sdpAnswer, roomKey);
  _log(`Posting answer to issue #${issueNumber}...`);
  const res = await fetch(`${_api}/issues/${issueNumber}/comments`, {
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
  await init();
  let etag = null;
  let polls = 0;
  _log(`Polling for answer on issue #${issueNumber}...`);
  while (!signal?.aborted) {
    const h = headers();
    if (etag) h['If-None-Match'] = etag;

    try {
      const res = await fetch(
        `${_api}/issues/${issueNumber}/comments?per_page=1`,
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
  await init();
  let etag = null;
  let polls = 0;
  const target = `[room:${roomId}]`;
  _log(`Polling for room: ${target}`);

  while (!signal?.aborted) {
    const h = headers();
    if (etag) h['If-None-Match'] = etag;

    try {
      const res = await fetch(
        `${_api}/issues?state=open&per_page=50&sort=created&direction=desc`,
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
  await init();
  await fetch(`${_api}/issues/${issueNumber}`, {
    method: 'PATCH',
    headers: headers(true),
    body: JSON.stringify({ state: 'closed' })
  });
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}
