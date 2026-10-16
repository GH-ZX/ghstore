-- Choosing what to sell from each supplier (Admin → Suppliers → Choose packages).
--
-- app.supplier_groups / app.supplier_items are a saved copy of what each
-- supplier offers, filled a group at a time (a G2Bulk game, or the whole list of
-- a supplier that lists everything at once: group id ''), on "Refresh list" and
-- by a scheduled job inside the per-run request limit. The admin screen reads
-- only this copy. Nothing here is sold by itself: offers stay the store's own.
--
-- product_key / product_name / package_name are the supplier's own suggestion of
-- how its items become store products (see SupplierProduct in packages/core).
-- missing_since is set when the supplier stops listing an item or a group.
--
-- suppliers.selection_version is bumped by every change to what a supplier
-- sells, so a screen loaded before someone else's change cannot apply over it.
-- import_category_id and import_description_* are what a new product gets when
-- it is created from this supplier's items ({name} is the product's name).
create table if not exists app.supplier_groups (
  supplier_id text not null references app.suppliers (id) on update cascade on delete cascade,
  id text not null check (length(id) <= 120),
  name text not null check (length(name) <= 200),
  image_url text check (image_url is null or length(image_url) <= 500),
  sort int not null default 0,
  missing_since timestamptz,
  first_items_at timestamptz,
  items_at timestamptz,
  items_error text,
  primary key (supplier_id, id)
);

create table if not exists app.supplier_items (
  supplier_id text not null references app.suppliers (id) on update cascade on delete cascade,
  external_id text not null check (length(external_id) <= 120),
  group_id text not null,
  name text not null check (length(name) <= 300),
  product_key text check (product_key is null or length(product_key) <= 160),
  product_name text check (product_name is null or length(product_name) <= 200),
  package_name text check (package_name is null or length(package_name) <= 300),
  cost_cents bigint not null check (cost_cents >= 0),
  available boolean not null,
  kind text not null check (kind in ('id', 'code', 'account', 'link', 'sms')),
  fields jsonb not null default '[]' check (jsonb_typeof(fields) = 'array'),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  missing_since timestamptz,
  primary key (supplier_id, external_id)
);
create index if not exists supplier_items_group_idx on app.supplier_items (supplier_id, group_id);

alter table app.supplier_groups enable row level security;
alter table app.supplier_items enable row level security;
create policy store_server_all on app.supplier_groups for all to store_server using (true) with check (true);
create policy store_server_all on app.supplier_items for all to store_server using (true) with check (true);
grant select, insert, update, delete on app.supplier_groups, app.supplier_items to store_server;

alter table app.suppliers
  add column if not exists groups_at timestamptz,
  add column if not exists selection_version int not null default 0,
  add column if not exists import_category_id uuid references app.categories (id) on delete set null,
  add column if not exists import_description_ar text not null default '' check (length(import_description_ar) <= 4000),
  add column if not exists import_description_en text not null default '' check (length(import_description_en) <= 4000);

-- Where new products go by default, for suppliers that sell one kind of thing.
-- (G2Bulk sells top-ups and gift cards: without a setting, a new product goes
-- where the supplier's products of the same kind already are.)
update app.suppliers s set import_category_id = c.id
  from app.categories c,
       (values ('maxstore', 'recharge'), ('fivesim', 'numbers')) as v(supplier, slug)
 where s.id = v.supplier and c.slug = v.slug and s.import_category_id is null;

-- A starting description per supplier, written for what it sells. Editable in
-- Admin → Suppliers → Settings; each product's own copy is editable in Catalogue.
update app.suppliers s set import_description_en = v.en, import_description_ar = v.ar
  from (values
    ('g2bulk',
     '{name}, delivered automatically. For top-ups, enter your player ID (and server, if asked): the balance lands on your account within minutes, usually instantly. Gift cards and vouchers appear as a code in your order right after payment. Please check your ID before buying: a top-up sent to a wrong ID cannot be taken back.',
     '{name} بتسليم تلقائي. للشحن أدخل معرّف اللاعب (والسيرفر إن طُلب): يصل الرصيد إلى حسابك خلال دقائق، وغالباً فوراً. أما البطاقات والقسائم فيظهر رمزها في طلبك مباشرة بعد الدفع. تأكد من المعرّف قبل الشراء: الشحن إلى معرّف خاطئ لا يمكن استرجاعه.'),
    ('batstore',
     '{name}, ready to use. Right after payment your account details or activation steps appear in your order, on the website and in the bot. Covered by the warranty shown on this page: if anything stops working during it, contact support and we will sort it out.',
     '{name} جاهز للاستخدام. بعد الدفع مباشرة تظهر بيانات الحساب أو خطوات التفعيل في طلبك، على الموقع وفي البوت. مشمول بالضمان المذكور في هذه الصفحة: إن توقف أي شيء خلال مدته تواصل مع الدعم ونحلّها لك.'),
    ('maxstore',
     '{name}, sent straight to the number or account you enter, usually within minutes. Double-check what you type before buying: credit sent to a wrong number cannot be returned.',
     '{name} يُرسل مباشرة إلى الرقم أو الحساب الذي تدخله، عادةً خلال دقائق. راجع ما كتبته قبل الشراء: الرصيد المرسل إلى رقم خاطئ لا يمكن إرجاعه.'),
    ('prodseller',
     '{name}, delivered as a key or an invite link in your order right after payment. Open it and follow the steps to activate. Questions? Support is one message away.',
     '{name} يصلك مفتاحاً أو رابط دعوة في طلبك مباشرة بعد الدفع. افتحه واتبع الخطوات للتفعيل. أي سؤال؟ الدعم على بعد رسالة.'),
    ('fivesim',
     'A virtual number for {name}, to receive your verification code by SMS. The code shows in your order as soon as it arrives. Use the number right away: it stays active for a short time only.',
     'رقم افتراضي لـ {name} لاستقبال رمز التحقق برسالة SMS. يظهر الرمز في طلبك فور وصوله. استخدم الرقم مباشرة: يبقى فعّالاً لفترة قصيرة فقط.')
  ) as v(supplier, en, ar)
 where s.id = v.supplier and s.import_description_en = '' and s.import_description_ar = '';

-- The home page showcase: each slide may pick its own look ("cinematic", a
-- poster; "deal", with the product's packages); null follows the store's
-- default (setting home.showcase_style, Admin → Home).
alter table app.banners
  add column if not exists look text check (look is null or look in ('cinematic', 'deal'));
