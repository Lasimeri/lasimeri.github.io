// compress.js — compression pipeline (Gzip, LZMA legacy)

// Compress data with specified format
export async function compress(data, format) {
  switch (format) {
    case 'gzip':
      return streamTransform(data, new CompressionStream('gzip'));
    case 'none':
      return data;
    default:
      throw new Error(`Unknown compression format: ${format}`);
  }
}

// Decompress data with specified format
export async function decompress(data, format) {
  switch (format) {
    case 'gzip':
      return streamTransform(data, new DecompressionStream('gzip'));
    case 'lzma':
      return decompressLzma(data);
    case 'none':
      return data;
    default:
      throw new Error(`Unknown decompression format: ${format}`);
  }
}

async function decompressLzma(data) {
  // Legacy path — dynamically load LZMA decoder
  return new Promise((resolve, reject) => {
    if (typeof LZMA !== 'undefined') {
      LZMA.decompress(data, (result, error) => {
        if (error) return reject(error);
        resolve(stringToBytes(result));
      });
      return;
    }

    const script = document.createElement('script');
    script.src = '/ittybitty/lib/lzma-d.min.js';
    script.onload = () => {
      LZMA.decompress(data, (result, error) => {
        if (error) return reject(error);
        resolve(stringToBytes(result));
      });
    };
    script.onerror = () => reject(new Error('Failed to load LZMA decoder'));
    document.head.appendChild(script);
  });
}

async function streamTransform(data, transform) {
  const writer = transform.writable.getWriter();
  writer.write(data);
  writer.close();

  const reader = transform.readable.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function stringToBytes(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i);
  }
  return bytes;
}
