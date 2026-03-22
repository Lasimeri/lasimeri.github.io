// render.js — sandboxed iframe content renderer

const DEFAULT_STYLE = `
* { box-sizing: border-box; }
body {
  font-family: system-ui, -apple-system, sans-serif;
  max-width: 720px;
  margin: 0 auto;
  padding: 2rem;
  color: #c8c8d0;
  background: #0a0a0f;
  line-height: 1.6;
}
img { max-width: 100%; height: auto; }
pre { overflow-x: auto; padding: 1rem; background: #12121a; border: 1px solid #1e1e2e; border-radius: 4px; }
code { font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace; font-size: 0.9em; }
a { color: #4a9eff; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #1e1e2e; padding: 0.5rem; text-align: left; }
h1, h2, h3, h4, h5, h6 { color: #e8e8f0; margin: 1.5em 0 0.5em; }
blockquote { border-left: 3px solid #4a9eff; padding-left: 1rem; color: #6e6e7e; margin: 1rem 0; }
hr { border: none; border-top: 1px solid #1e1e2e; margin: 2rem 0; }
`.trim();

const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob: https:; font-src data:; media-src data: blob:; script-src 'unsafe-inline'">`;

const RESIZE_SCRIPT = `
<script>
  new ResizeObserver(() => {
    parent.postMessage({ type: 'ittybitty-resize', height: document.documentElement.scrollHeight }, '*');
  }).observe(document.body);
  parent.postMessage({ type: 'ittybitty-resize', height: document.documentElement.scrollHeight }, '*');
</script>
`;

let markedLoaded = null;

async function loadMarked() {
  if (markedLoaded) return markedLoaded;
  const script = document.createElement('script');
  script.src = '/ittybitty/lib/marked.min.js';
  await new Promise((resolve, reject) => {
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  markedLoaded = window.marked;
  return markedLoaded;
}

function wrapHTML(body, options = {}) {
  const allowScripts = options.allowScripts || false;
  const csp = allowScripts ? '' : CSP;
  const resize = allowScripts ? '' : RESIZE_SCRIPT.replace('<script>', '<script>').replace('</script>', '</' + 'script>');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${csp}
<style>${DEFAULT_STYLE}</style>
</head>
<body>${body}${resize}</body>
</html>`;
}

function escapeHTML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function render(content, type, container) {
  container.innerHTML = '';

  let srcdoc;

  switch (type) {
    case 'html':
      // For HTML, inject default style but allow the content's own styles to override
      srcdoc = injectIntoHTML(content);
      break;

    case 'markdown': {
      const marked = await loadMarked();
      const html = marked.parse(content);
      srcdoc = wrapHTML(html);
      break;
    }

    case 'svg':
      srcdoc = wrapHTML(content);
      break;

    case 'json': {
      let formatted;
      try {
        const parsed = JSON.parse(content);
        formatted = JSON.stringify(parsed, null, 2);
      } catch {
        formatted = content;
      }
      srcdoc = wrapHTML(`<pre><code>${escapeHTML(formatted)}</code></pre>`);
      break;
    }

    case 'text':
    default:
      srcdoc = wrapHTML(`<pre>${escapeHTML(content)}</pre>`);
      break;
  }

  const iframe = document.createElement('iframe');
  iframe.sandbox = 'allow-scripts';
  iframe.srcdoc = srcdoc;

  // Auto-resize
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'ittybitty-resize' && e.source === iframe.contentWindow) {
      iframe.style.height = `${e.data.height + 20}px`;
    }
  });

  container.appendChild(iframe);
  return iframe;
}

function injectIntoHTML(html) {
  const resizeTag = RESIZE_SCRIPT.replace('</script>', '</' + 'script>');

  // If the HTML has a <head>, inject our defaults there
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch) {
    const insertPos = headMatch.index + headMatch[0].length;
    const injected = `\n${CSP}\n<style>${DEFAULT_STYLE}</style>\n`;
    let result = html.slice(0, insertPos) + injected + html.slice(insertPos);
    // Inject resize script before </body> or at end
    const bodyEnd = result.match(/<\/body>/i);
    if (bodyEnd) {
      result = result.slice(0, bodyEnd.index) + resizeTag + result.slice(bodyEnd.index);
    } else {
      result += resizeTag;
    }
    return result;
  }

  // If it has <html> but no <head>, add one
  const htmlMatch = html.match(/<html[^>]*>/i);
  if (htmlMatch) {
    const insertPos = htmlMatch.index + htmlMatch[0].length;
    const injected = `\n<head>${CSP}<style>${DEFAULT_STYLE}</style></head>\n`;
    let result = html.slice(0, insertPos) + injected + html.slice(insertPos);
    const bodyEnd = result.match(/<\/body>/i);
    if (bodyEnd) {
      result = result.slice(0, bodyEnd.index) + resizeTag + result.slice(bodyEnd.index);
    } else {
      result += resizeTag;
    }
    return result;
  }

  // Bare HTML fragment — wrap it
  return wrapHTML(html);
}

export function detectType(content) {
  const trimmed = content.trimStart();

  if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed) || /^<head[\s>]/i.test(trimmed) || /^<body[\s>]/i.test(trimmed)) {
    return 'html';
  }

  if (/^<svg[\s>]/i.test(trimmed)) return 'svg';

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(content);
      return 'json';
    } catch {}
  }

  // Check for markdown indicators
  if (/^#{1,6}\s/m.test(content) || /\*\*[^*]+\*\*/m.test(content) || /\[.+\]\(.+\)/m.test(content)) {
    return 'markdown';
  }

  // If it contains HTML tags, treat as HTML
  if (/<[a-z][^>]*>/i.test(trimmed)) return 'html';

  return 'text';
}
