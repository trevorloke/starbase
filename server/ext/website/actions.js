// Website + store actions. Managers and staff edit the site and the store;
// managers, staff and treasurers see orders, and managers and staff move
// them along. Every change is one runAction: table writes + events on the
// hash chain. Image bytes never go on the chain — only their id and size.
//
//   site.settings.save   { …any settings field }        (content.js DEFAULTS)
//   site.page.save       { id?, title, slug?, body, hero_image, show_in_nav, nav_order, published }
//   site.page.delete     { id }
//   site.post.save       { id?, title, slug?, date, summary, body, cover_image, published, pinned }
//   site.post.publish    { id, published }
//   site.post.delete     { id }
//   site.team.save       { id?, name, role, bio, photo, socials, position, published }
//   site.team.delete     { id }
//   site.media.upload    { data (base64), name?, width?, height? }
//   site.media.delete    { id }
//   site.event.image     { event_id, image }   the picture an event shows on the site
//   store.product.save   { id?, name, slug?, description, price_cents, images, variants, track_stock, stock, active, position }
//   store.product.delete { id }
//   store.order.update   { id, status, restock? }
import { z } from 'zod';
import { newId } from '../../lib/events.js';
import { httpError } from '../../actions/util.js';
import {
  DEFAULTS, SECTIONS, SOCIALS, SLUG_RE, RESERVED_SLUGS, slugify, freeSlug, parseJ,
} from './content.js';
import { readUpload } from './media.js';
import { ORDER_STATUSES, STOCK_OUT, moveStock } from './store.js';

const EDIT = ['manager', 'staff'];

const text = (max) => z.string().trim().max(max);
const body = () => z.string().max(50_000);
const mediaId = () => z.uuid().nullable();
const hex = () => z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a colour like #6d4aff');
const httpsUrl = () => z.string().trim().max(300).refine((v) => v === '' || /^https:\/\/[^\s"'<>]+$/.test(v), 'a link starting with https://');
const socials = () => z.object(Object.fromEntries(SOCIALS.map(([k]) => [k, httpsUrl().optional()]))).partial();

const checkMedia = async (tx, ws, ids) => {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return;
  const n = (await tx.query(
    `select count(*)::int as n from site_media where workspace_id = $1
       and id in (select (jsonb_array_elements_text($2::jsonb))::uuid)`,
    [ws, JSON.stringify(list)],
  )).rows[0].n;
  if (n !== list.length) throw httpError(400, 'picture not found — upload it again');
};

// A link someone typed, or one made from the title. A typed one that is
// taken is refused (it may be printed somewhere); a made one gets -2, -3.
const pickSlug = async (tx, table, ws, { typed, title, id, current }) => {
  if (typed) {
    const s = slugify(typed);
    if (!SLUG_RE.test(s)) throw httpError(400, 'link: letters, numbers and dashes');
    if (table === 'site_pages' && RESERVED_SLUGS.has(s) && s !== current) throw httpError(400, `the link '${s}' is used by the site itself — pick another`);
    const hit = (await tx.query(
      `select 1 from ${table} where workspace_id = $1 and slug = $2 and ($3::uuid is null or id <> $3::uuid)`, [ws, s, id || null],
    )).rows[0];
    if (hit) throw httpError(409, `the link '${s}' is already used`);
    return s;
  }
  if (current) return current;
  let base = slugify(title) || 'page';
  if (table === 'site_pages' && RESERVED_SLUGS.has(base)) base = `${base}-page`;
  return freeSlug(tx, table, ws, base);
};

const loadRow = async (tx, table, ws, id, what) => {
  const row = (await tx.query(`select * from ${table} where id = $1 and workspace_id = $2 for update`, [id, ws])).rows[0];
  if (!row) throw httpError(404, `${what} not found`);
  return row;
};

const settingsInput = z.object({
  title: text(80),
  tagline: text(160),
  hero_headline: text(140),
  hero_text: text(400),
  hero_image: mediaId(),
  primary: hex(),
  accent: hex(),
  contact_email: z.union([z.literal(''), z.email().max(320)]),
  contact_phone: text(40),
  socials: socials(),
  authorized_by: text(300),
  donate_label: text(30).min(1),
  involved_label: text(30).min(1),
  seo_description: text(300),
  nav_order: z.array(z.string().max(80)).max(60),
  hidden_sections: z.array(z.enum(SECTIONS.map(([k]) => k))).max(SECTIONS.length),
  shipping: z.boolean(),
  shipping_cents: z.number().int().min(0).max(100_000),
  pickup: z.boolean(),
  pickup_note: text(300),
}).partial();

const variantsInput = () => z.array(z.object({
  label: z.string().trim().min(1).max(40),
  stock: z.number().int().min(0).max(100_000).nullable().optional(),
})).max(20);

const productOut = (p) => ({ ...p, images: parseJ(p.images, []), variants: parseJ(p.variants, []) });

export const actions = {
  'site.settings.save': {
    roles: EDIT,
    input: settingsInput,
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      if ('hero_image' in input) await checkMedia(tx, ws, [input.hero_image]);
      if (input.socials) input.socials = Object.fromEntries(Object.entries(input.socials).filter(([, v]) => v));
      const cur = parseJ((await tx.query('select data from site_settings where workspace_id = $1 for update', [ws])).rows[0]?.data, {});
      const next = { ...cur, ...input };
      // Only fields this version knows are kept.
      for (const k of Object.keys(next)) if (!(k in DEFAULTS)) delete next[k];
      await tx.query(
        `insert into site_settings (workspace_id, data, updated_at) values ($1, $2, now())
         on conflict (workspace_id) do update set data = $2, updated_at = now()`,
        [ws, JSON.stringify(next)],
      );
      emit('site_settings', ws, 'update', input);
      return { settings: next };
    },
  },

  'site.page.save': {
    roles: EDIT,
    input: z.object({
      id: z.uuid().optional(),
      title: text(120).min(1),
      slug: text(80).optional(),
      body: body().default(''),
      hero_image: mediaId().default(null),
      show_in_nav: z.boolean().default(true),
      nav_order: z.number().int().min(0).max(10_000).default(100),
      published: z.boolean().default(false),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      await checkMedia(tx, ws, [input.hero_image]);
      const cur = input.id ? await loadRow(tx, 'site_pages', ws, input.id, 'page') : null;
      // Home is the front page's welcome: its link never changes.
      const typed = cur?.slug === 'home' ? null : input.slug;
      const slug = await pickSlug(tx, 'site_pages', ws, { typed, title: input.title, id: input.id, current: cur?.slug });
      const id = cur?.id || newId();
      const row = [id, ws, slug, input.title, input.body, input.hero_image, input.show_in_nav, input.nav_order, input.published];
      if (cur) {
        await tx.query(
          `update site_pages set slug = $3, title = $4, body = $5, hero_image = $6, show_in_nav = $7, nav_order = $8,
             published = $9, updated_at = now() where id = $1 and workspace_id = $2`, row,
        );
      } else {
        await tx.query(
          `insert into site_pages (id, workspace_id, slug, title, body, hero_image, show_in_nav, nav_order, published)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, row,
        );
      }
      const { body: text_, ...rest } = input;
      emit('site_page', id, cur ? 'update' : 'create', { ...rest, id, slug, body_chars: text_.length });
      return { page: { id, slug, title: input.title, published: input.published } };
    },
  },

  'site.page.delete': {
    roles: EDIT,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await loadRow(tx, 'site_pages', ctx.workspaceId, input.id, 'page');
      await tx.query('delete from site_pages where id = $1', [cur.id]);
      emit('site_page', cur.id, 'void', { slug: cur.slug, title: cur.title });
      return { id: cur.id };
    },
  },

  'site.post.save': {
    roles: EDIT,
    input: z.object({
      id: z.uuid().optional(),
      title: text(160).min(1),
      slug: text(80).optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-10-23'),
      summary: text(400).default(''),
      body: body().default(''),
      cover_image: mediaId().default(null),
      published: z.boolean().default(false),
      pinned: z.boolean().default(false),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      await checkMedia(tx, ws, [input.cover_image]);
      const cur = input.id ? await loadRow(tx, 'site_posts', ws, input.id, 'post') : null;
      const slug = await pickSlug(tx, 'site_posts', ws, { typed: input.slug, title: input.title, id: input.id, current: cur?.slug });
      const id = cur?.id || newId();
      const row = [id, ws, slug, input.title, input.date, input.summary, input.body, input.cover_image, input.published, input.pinned];
      if (cur) {
        await tx.query(
          `update site_posts set slug = $3, title = $4, date = $5, summary = $6, body = $7, cover_image = $8,
             published = $9, pinned = $10, updated_at = now() where id = $1 and workspace_id = $2`, row,
        );
      } else {
        await tx.query(
          `insert into site_posts (id, workspace_id, slug, title, date, summary, body, cover_image, published, pinned)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, row,
        );
      }
      const { body: text_, ...rest } = input;
      emit('site_post', id, cur ? 'update' : 'create', { ...rest, id, slug, body_chars: text_.length });
      return { post: { id, slug, title: input.title, published: input.published } };
    },
  },

  'site.post.publish': {
    roles: EDIT,
    input: z.object({ id: z.uuid(), published: z.boolean() }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await loadRow(tx, 'site_posts', ctx.workspaceId, input.id, 'post');
      await tx.query('update site_posts set published = $2, updated_at = now() where id = $1', [cur.id, input.published]);
      emit('site_post', cur.id, 'update', { published: input.published });
      return { id: cur.id, published: input.published };
    },
  },

  'site.post.delete': {
    roles: EDIT,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await loadRow(tx, 'site_posts', ctx.workspaceId, input.id, 'post');
      await tx.query('delete from site_posts where id = $1', [cur.id]);
      emit('site_post', cur.id, 'void', { slug: cur.slug, title: cur.title });
      return { id: cur.id };
    },
  },

  'site.team.save': {
    roles: EDIT,
    input: z.object({
      id: z.uuid().optional(),
      name: text(120).min(1),
      role: text(80).default(''),
      bio: text(1200).default(''),
      photo: mediaId().default(null),
      socials: socials().default({}),
      position: z.number().int().min(0).max(10_000).default(100),
      published: z.boolean().default(true),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      await checkMedia(tx, ws, [input.photo]);
      const cur = input.id ? await loadRow(tx, 'site_team', ws, input.id, 'person') : null;
      const id = cur?.id || newId();
      const links = Object.fromEntries(Object.entries(input.socials).filter(([, v]) => v));
      const row = [id, ws, input.name, input.role, input.bio, input.photo, JSON.stringify(links), input.position, input.published];
      if (cur) {
        await tx.query(
          `update site_team set name = $3, role = $4, bio = $5, photo = $6, socials = $7, position = $8, published = $9,
             updated_at = now() where id = $1 and workspace_id = $2`, row,
        );
      } else {
        await tx.query(
          `insert into site_team (id, workspace_id, name, role, bio, photo, socials, position, published)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, row,
        );
      }
      emit('site_team', id, cur ? 'update' : 'create', { ...input, socials: links, id });
      return { member: { id, name: input.name } };
    },
  },

  'site.team.delete': {
    roles: EDIT,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await loadRow(tx, 'site_team', ctx.workspaceId, input.id, 'person');
      await tx.query('delete from site_team where id = $1', [cur.id]);
      emit('site_team', cur.id, 'void', { name: cur.name });
      return { id: cur.id };
    },
  },

  'site.media.upload': {
    roles: EDIT,
    input: z.object({
      data: z.string().min(1).max(3_000_000),
      name: text(200).optional(),
      width: z.number().int().min(1).max(20_000).optional(),
      height: z.number().int().min(1).max(20_000).optional(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const up = readUpload(input.data);
      if (up.error) throw httpError(400, up.error);
      const id = newId();
      await tx.query(
        `insert into site_media (id, workspace_id, content_type, bytes, width, height, name, data, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, ctx.workspaceId, up.type, up.buf.length, input.width ?? null, input.height ?? null, input.name || null, up.buf, ctx.user?.id || null],
      );
      const media = { id, content_type: up.type, bytes: up.buf.length, width: input.width ?? null, height: input.height ?? null, name: input.name || null };
      emit('site_media', id, 'create', media);
      return { media: { ...media, url: `/media/${id}` } };
    },
  },

  'site.media.delete': {
    roles: EDIT,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const n = await tx.query('delete from site_media where id = $1 and workspace_id = $2', [input.id, ctx.workspaceId]);
      if (n.affectedRows === 0) throw httpError(404, 'picture not found');
      emit('site_media', input.id, 'void', {});
      return { id: input.id };
    },
  },

  'site.event.image': {
    roles: EDIT,
    input: z.object({ event_id: z.uuid(), image: mediaId() }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const ev = (await tx.query('select id from campaign_events where id = $1 and workspace_id = $2 and deleted_at is null', [input.event_id, ws])).rows[0];
      if (!ev) throw httpError(404, 'event not found');
      await checkMedia(tx, ws, [input.image]);
      await tx.query(
        `insert into site_event_extras (event_id, workspace_id, image, updated_at) values ($1, $2, $3, now())
         on conflict (event_id) do update set image = $3, updated_at = now()`,
        [ev.id, ws, input.image],
      );
      emit('campaign_event', ev.id, 'update', { image: input.image });
      return { event_id: ev.id, image: input.image };
    },
  },

  'store.product.save': {
    roles: EDIT,
    input: z.object({
      id: z.uuid().optional(),
      name: text(120).min(1),
      slug: text(80).optional(),
      description: z.string().max(8000).default(''),
      price_cents: z.number().int().min(50, 'at least $0.50').max(1_000_000),
      images: z.array(z.uuid()).max(8).default([]),
      variants: variantsInput().default([]),
      track_stock: z.boolean().default(false),
      stock: z.number().int().min(0).max(100_000).nullable().default(null),
      active: z.boolean().default(true),
      position: z.number().int().min(0).max(10_000).default(100),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      await checkMedia(tx, ws, input.images);
      const labels = input.variants.map((v) => v.label.toLowerCase());
      if (new Set(labels).size !== labels.length) throw httpError(400, 'two sizes have the same name');
      const variants = input.variants.map((v) => ({ label: v.label, stock: input.track_stock ? (v.stock ?? 0) : null }));
      const stock = input.track_stock && !variants.length ? (input.stock ?? 0) : null;
      const cur = input.id ? await loadRow(tx, 'store_products', ws, input.id, 'product') : null;
      if (cur?.deleted_at) throw httpError(404, 'product not found');
      const slug = await pickSlug(tx, 'store_products', ws, { typed: input.slug, title: input.name, id: input.id, current: cur?.slug });
      const id = cur?.id || newId();
      const row = [id, ws, slug, input.name, input.description, input.price_cents, JSON.stringify(input.images),
        JSON.stringify(variants), input.track_stock, stock, input.active, input.position];
      if (cur) {
        await tx.query(
          `update store_products set slug = $3, name = $4, description = $5, price_cents = $6, images = $7, variants = $8,
             track_stock = $9, stock = $10, active = $11, position = $12, updated_at = now()
           where id = $1 and workspace_id = $2`, row,
        );
      } else {
        await tx.query(
          `insert into store_products (id, workspace_id, slug, name, description, price_cents, images, variants, track_stock, stock, active, position)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, row,
        );
      }
      const { description, ...rest } = input;
      emit('store_product', id, cur ? 'update' : 'create', { ...rest, id, slug, variants, stock, description_chars: description.length });
      return { product: productOut({ id, slug, name: input.name, price_cents: input.price_cents, images: input.images, variants, track_stock: input.track_stock, stock, active: input.active }) };
    },
  },

  'store.product.delete': {
    roles: EDIT,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      // Orders keep their own copy of names and prices; the link is freed.
      const n = await tx.query(
        `update store_products set deleted_at = now(), active = false, slug = slug || '--deleted-' || left(id::text, 8)
         where id = $1 and workspace_id = $2 and deleted_at is null`,
        [input.id, ctx.workspaceId],
      );
      if (n.affectedRows === 0) throw httpError(404, 'product not found');
      emit('store_product', input.id, 'void', {});
      return { id: input.id };
    },
  },

  // paid → packed → shipped / picked up; refunded or cancelled any time
  // (the card refund itself is done in Stripe). restock puts a paid order's
  // items back on the shelf when it is refunded or cancelled.
  'store.order.update': {
    roles: EDIT,
    input: z.object({
      id: z.uuid(),
      status: z.enum(ORDER_STATUSES.filter((s) => s !== 'pending')),
      restock: z.boolean().default(false),
    }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await loadRow(tx, 'store_orders', ctx.workspaceId, input.id, 'order');
      if (cur.status === input.status) return { id: cur.id, status: cur.status };
      if (cur.status === 'pending' && input.status !== 'cancelled') throw httpError(409, 'this order was never paid');
      if (['refunded', 'cancelled'].includes(cur.status)) throw httpError(409, `this order is already ${cur.status}`);
      const back = input.restock && STOCK_OUT.has(cur.status) && ['refunded', 'cancelled'].includes(input.status);
      if (back) await moveStock(tx, ctx.workspaceId, parseJ(cur.items, []), +1);
      await tx.query('update store_orders set status = $2, updated_at = now() where id = $1', [cur.id, input.status]);
      emit('store_order', cur.id, 'update', { status: input.status, from: cur.status, restocked: back });
      return { id: cur.id, status: input.status, restocked: back };
    },
  },
};
