// Images for the website: jpg, png or webp, at most MEDIA_MAX bytes (the
// editor shrinks a photo to 2000px and about 1.5 MB before it uploads). The
// type is read from the file's own first bytes, never from what the browser
// says. Served at /media/:id with a year-long cache: an id's bytes never
// change (a new picture is a new id).
export const MEDIA_MAX = 2 * 1024 * 1024;
export const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export const sniffImage = (buf) => {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
};

// base64 (or a data: URL) → { buf, type } or an error message.
export const readUpload = (data) => {
  const b64 = String(data || '').replace(/^data:[^;,]*;base64,/, '');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) return { error: 'not an image file' };
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return { error: 'empty file' };
  if (buf.length > MEDIA_MAX) return { error: 'this picture is too big — 2 MB at most' };
  const type = sniffImage(buf);
  if (!type) return { error: 'use a JPG, PNG or WebP picture' };
  return { buf, type };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /media/:id (any host). Only the site's own uploads exist here, and
// they are meant to be public (a draft's picture is unlisted, not secret).
export const serveMedia = async (c, db) => {
  const id = String(c.req.param('id') || '').replace(/\.(jpe?g|png|webp)$/i, '');
  if (!UUID.test(id)) return c.text('not found', 404);
  const row = (await db.query('select content_type, data from site_media where id = $1', [id])).rows[0];
  if (!row) return c.text('not found', 404);
  const body = Buffer.from(row.data);
  return c.body(body, 200, {
    'Content-Type': row.content_type,
    'Content-Length': String(body.length),
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
  });
};
