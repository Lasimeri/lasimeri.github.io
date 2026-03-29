// storage.js - GitHub Issues API for chunked file storage

import { unlock, unseal, dropDerivedKey } from './secrets.js?v=1';

const _e=[
['kt3Wob4k','4IBlLVWt','SmX9Rf1d','gNuH0Ahg','d2RCNMn5','0H5ej5C5'],
['l3fHwkQr','nXodkY2S','PfFQigBV','58VEP7Eg','keIYC3dW','AusuFVqm','BoHUPKg='],
['SgCD1vq3','YcLm5Kyb','8ED0dtDT','vTzMPjLR','zAmSG3bt','VAgDO/5b','JqGaYIMd','L8W05VHQ','+oiI/6bu','us7GwbZD','b/qhtgYq','iJ4=']
];
let _s0=null,_s1=null,_s2=null;

let _initPromise=null;
async function _doInit(){
_s0=await unlock(_e[0].join(''));
_s1=await unlock(_e[1].join(''));
_s2=await unlock(_e[2].join(''));
dropDerivedKey()}
function init(){
if(!_initPromise)_initPromise=_doInit();
return _initPromise;}

let _log = () => {};
export function setLogger(fn) { _log = fn; }

async function apiUrl(path) {
  const [o, r] = await Promise.all([unseal(_s0), unseal(_s1)]);
  return `https://api.github.com/repos/${o}/${r}${path}`;
}

async function headers(write = false) {
  const t = await unseal(_s2);
  const h = {
    'Authorization': `Bearer ${t}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (write) h['Content-Type'] = 'application/json';
  return h;
}

// Create issue with metadata only in body
export async function createFile(fileId, metadata, prefix = 'file') {
  await init();
  const title = '[' + prefix + ':' + fileId + ']';
  _log('Creating issue ' + title + '...');
  const res = await fetch(await apiUrl('/issues'), {
    method: 'POST',
    headers: await headers(true),
    body: JSON.stringify({
      title: title,
      body: JSON.stringify(metadata)
    })
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error('Failed to create issue: ' + res.status + ' ' + err);
  }
  const data = await res.json();
  _log('Issue #' + data.number + ' created');
  return data.number;
}

// Post a chunk as a comment
export async function postChunk(issueNumber, chunkIndex, chunkData) {
  await init();
  const res = await fetch(await apiUrl('/issues/' + issueNumber + '/comments'), {
    method: 'POST',
    headers: await headers(true),
    body: JSON.stringify({ body: chunkData })
  });
  if (!res.ok) throw new Error('Failed to post chunk ' + chunkIndex + ': ' + res.status);
  _log('Chunk ' + chunkIndex + ' posted');
}

// Fetch file: get issue body (metadata + chunk 0) + all comments (chunks 1..N)
export async function fetchFile(fileId) {
  await init();
  _log('Fetching file: ' + fileId);

  // Find the issue
  let issueNumber = null;
  let issueBody = null;
  let page = 1;
  while (page <= 10) {
    const res = await fetch(
      await apiUrl('/issues?state=all&per_page=100&page=' + page + '&sort=created&direction=desc'),
      { headers: await headers() }
    );
    if (!res.ok) throw new Error('Fetch failed: ' + res.status);
    const issues = await res.json();
    if (issues.length === 0) break;
    const match = issues.find(i => {
      const m = i.title.match(/^\[(file|pub-file):([^\]]+)\]/);
      return m && m[2] === fileId;
    });
    if (match) {
      issueNumber = match.number;
      issueBody = match.body;
      break;
    }
    page++;
  }
  if (!issueNumber) throw new Error('File not found');
  _log('Found issue #' + issueNumber);

  // Parse body: metadata only
  const metadata = JSON.parse(issueBody);

  // Fetch all chunks from comments
  const chunks = [];
  let commentPage = 1;
  while (true) {
    const res = await fetch(
      await apiUrl('/issues/' + issueNumber + '/comments?per_page=100&page=' + commentPage),
      { headers: await headers() }
    );
    if (!res.ok) throw new Error('Failed to fetch comments: ' + res.status);
    const comments = await res.json();
    if (comments.length === 0) break;
    for (const c of comments) chunks.push(c.body);
    _log('Fetched ' + chunks.length + '/' + metadata.chunks + ' chunks');
    commentPage++;
  }

  return { metadata, chunks };
}

// List all hosted files
export async function listFiles() {
  await init();
  _log('Listing files...');
  const res = await fetch(
    await apiUrl('/issues?state=open&per_page=50&sort=created&direction=desc'),
    { headers: await headers() }
  );
  if (!res.ok) throw new Error('List failed: ' + res.status);
  const issues = await res.json();
  return issues
    .filter(i => i.title.startsWith('[file:') || i.title.startsWith('[pub-file:'))
    .map(i => {
      const isPublic = i.title.startsWith('[pub-file:');
      const id = isPublic ? i.title.slice(10, -1) : i.title.slice(6, -1);
      // Extract filename from metadata in body for public files
      let name = null;
      if (isPublic && i.body) {
        try {
          const meta = JSON.parse(i.body);
          name = meta.name;
        } catch (e) {}
      }
      return { id, name, created: i.created_at, issueNumber: i.number, isPublic };
    });
}
