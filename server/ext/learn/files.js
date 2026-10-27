// Files behind a lesson: a PDF, a picture, audio, a short video, or an
// Office document — at most ASSET_MAX bytes, the type read from the file's
// own first bytes (an Office file is a zip; its extension says which).
export const ASSET_MAX = 12 * 1024 * 1024;
const OFFICE = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
export const sniff = (buf, name = '') => {
  if (!buf || buf.length < 12) return null;
  const s = (a, b) => buf.toString('ascii', a, b);
  if (s(0, 4) === '%PDF') return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && s(1, 4) === 'PNG') return 'image/png';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return 'image/webp';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return 'audio/wav';
  if (s(0, 6) === 'GIF87a' || s(0, 6) === 'GIF89a') return 'image/gif';
  if (s(0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (s(0, 4) === 'OggS') return 'audio/ogg';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm';
  if (s(4, 8) === 'ftyp') {
    const brand = s(8, 12);
    return /^M4A/.test(brand) ? 'audio/mp4' : 'video/mp4';
  }
  if (s(0, 2) === 'PK') {
    const ext = String(name).toLowerCase().split('.').pop();
    return OFFICE[ext] || null;
  }
  return null;
};
export const readFile = (data, name) => {
  const b64 = String(data || '').replace(/^data:[^;,]*;base64,/, '');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) return { error: 'not a file' };
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return { error: 'empty file' };
  if (buf.length > ASSET_MAX) return { error: 'this file is too big — 12 MB at most; link to a video instead of uploading it' };
  const type = sniff(buf, name);
  if (!type) return { error: 'use a PDF, a Word, PowerPoint or Excel file, a JPG, PNG, WebP or GIF picture, an MP3, M4A, WAV or OGG recording, or an MP4 or WebM video' };
  return { buf, type };
};
// What a file is, for the lesson's kind and its icon.
export const kindOfType = (type) => (type.startsWith('image/') ? 'picture' : type.startsWith('audio/') ? 'audio' : type.startsWith('video/') ? 'video' : 'document');
