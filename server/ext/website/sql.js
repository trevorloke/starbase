// Website + store tables. Idempotent: run at every boot after the core schema.
//
//   site_settings      one row per workspace: the site's words, colours,
//                      links and store options (jsonb, shape in content.js)
//   site_pages         simple pages (About, Platform, …): Markdown body,
//                      optional hero image, in the menu or not, draft/published
//   site_posts         news: date, summary, cover, body, pinned to home
//   site_team          people cards (candidates, team): photo, role, bio, socials
//   site_media         uploaded images, the bytes themselves (so a database
//                      backup holds them too); served at /media/:id
//   site_event_extras  what the site adds to a campaign event (its picture) —
//                      events themselves stay in campaign_events
//   store_products     merch: price in cents (CAD), photos, sizes with stock
//   store_orders       one per checkout; items and prices fixed when it was
//                      made; paid by the Stripe webhook
export const sql = `
create table if not exists site_settings (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  data jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create table if not exists site_media (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  bytes int not null,
  width int,
  height int,
  name text,
  data bytea not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index if not exists site_media_ws_idx on site_media (workspace_id, created_at);

create table if not exists site_pages (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  slug text not null,
  title text not null,
  body text not null default '',
  hero_image uuid references site_media(id) on delete set null,
  show_in_nav boolean not null default true,
  nav_order int not null default 100,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug)
);

create table if not exists site_posts (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  slug text not null,
  title text not null,
  date date not null,
  summary text not null default '',
  body text not null default '',
  cover_image uuid references site_media(id) on delete set null,
  published boolean not null default false,
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug)
);
create index if not exists site_posts_ws_idx on site_posts (workspace_id, published, date desc);

create table if not exists site_team (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  role text not null default '',
  bio text not null default '',
  photo uuid references site_media(id) on delete set null,
  socials jsonb not null default '{}',
  position int not null default 100,
  published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists site_event_extras (
  event_id uuid primary key references campaign_events(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  image uuid references site_media(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists store_products (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  slug text not null,
  name text not null,
  description text not null default '',
  price_cents int not null check (price_cents >= 50),
  images jsonb not null default '[]',
  variants jsonb not null default '[]',
  track_stock boolean not null default false,
  stock int,
  active boolean not null default true,
  position int not null default 100,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug)
);

create table if not exists store_orders (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'packed', 'shipped', 'picked_up', 'refunded', 'cancelled')),
  fulfilment text not null check (fulfilment in ('ship', 'pickup')),
  items jsonb not null,
  subtotal_cents int not null,
  shipping_cents int not null default 0,
  total_cents int not null,
  paid_cents int,
  buyer_name text,
  email text,
  phone text,
  ship_address jsonb,
  person_id uuid references persons(id) on delete set null,
  stripe_session_id text,
  payment_intent text,
  note text,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists store_orders_ws_idx on store_orders (workspace_id, status, created_at desc);
create index if not exists store_orders_session_idx on store_orders (stripe_session_id);

-- Who started a checkout, to cap open ones per address (not shown anywhere).
alter table store_orders add column if not exists client_ip text;
`;
