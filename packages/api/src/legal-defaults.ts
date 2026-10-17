/**
 * The built-in texts of the store's legal pages (Admin → SEO & pages), until the
 * owner edits them. They describe how this app works (wallet, delivery, numbers,
 * refunds to the wallet); the owner should read them and adapt them. Placeholders:
 * {store} the store's name, {site} its domain, {url} its address, {contact} the
 * support channels from Admin → Settings.
 */
export interface DefaultPage {
  slug: string;
  titleAr: string;
  titleEn: string;
  bodyAr: string;
  bodyEn: string;
  sort: number;
}

/** When these texts last changed (shown as the pages' date until the owner edits them). */
export const DEFAULTS_UPDATED = "2026-10-17T00:00:00Z";

const privacyEn = `{store} ("we") runs the store at {site} and in Telegram. This policy explains what we collect when you use it, why, and what you can ask of us.

## What we collect
- **Your account:** your Telegram ID, name and username when you use Telegram; your email address when you sign in with email or Google.
- **Your orders:** what you buy, the details a product needs to be delivered (for example a player ID or an account email), and what we delivered to you.
- **Your wallet:** your balance, your top-ups and how you paid (for example a ShamCash transfer number or a USDT transaction hash).
- **Technical data:** basic logs (time, pages requested, errors) that keep the store working and safe.

We never see your bank card, or the passwords of your Telegram, Google or email accounts.

## Why we use it
- To sign you in, deliver your orders and keep your balance right.
- To send you what you asked for: order updates, codes and receipts.
- To help you when you contact us.
- To prevent fraud and abuse, and to meet our legal obligations.

We don't sell your data and we don't use it for advertising.

## Who else sees it
Only what each one needs to do its job:
- **Suppliers** who deliver a product get the details that product needs (for example your player ID).
- **Payment services** (ShamCash, Telegram Stars, the blockchain for USDT) handle your payments under their own terms.
- **Our hosting and sign-in providers** (Cloudflare, Supabase) and **Telegram** keep the store running.
- **Authorities**, when the law requires it.

## Cookies and storage
We use one cookie to keep you signed in, and your browser's storage to remember your language and theme. No advertising or tracking cookies.

## How long we keep it
Your account data for as long as you have an account. Orders and payments for as long as accounting and the law require, also after an account is closed.

## Your choices
You can ask us for a copy of your data, to correct it, or to delete your account. Contact us below; we may keep the records we are required to keep.

## Children
The store is not meant for children under 13. Some games and services have their own age limits: please follow them.

## Changes
We may update this policy; the date on this page shows the latest version. Important changes will be announced in the store.

## Contact
{contact}`;

const privacyAr = `يدير {store} ("نحن") المتجر على {site} وفي تيليجرام. توضح هذه السياسة ما نجمعه عند استخدامك له، ولماذا، وما يمكنك أن تطلبه منا.

## ما الذي نجمعه
- **حسابك:** معرّفك في تيليجرام واسمك واسم المستخدم عند استخدام تيليجرام، وبريدك الإلكتروني عند الدخول بالبريد أو جوجل.
- **طلباتك:** ما تشتريه، والبيانات اللازمة لتسليم المنتج (مثل معرّف اللاعب أو بريد الحساب)، وما سلّمناه لك.
- **محفظتك:** رصيدك وعمليات الشحن وطريقة الدفع (مثل رقم تحويل شام كاش أو رقم معاملة USDT).
- **بيانات تقنية:** سجلات بسيطة (الوقت، الصفحات المطلوبة، الأخطاء) تحافظ على عمل المتجر وأمانه.

لا نرى أبداً بطاقتك البنكية، ولا كلمات مرور حساباتك في تيليجرام أو جوجل أو بريدك.

## لماذا نستخدمها
- لتسجيل دخولك وتسليم طلباتك وضبط رصيدك.
- لنرسل لك ما طلبته: تحديثات الطلبات والأكواد والإيصالات.
- لمساعدتك عندما تتواصل معنا.
- لمنع الاحتيال وإساءة الاستخدام، والوفاء بالتزاماتنا القانونية.

لا نبيع بياناتك ولا نستخدمها للإعلانات.

## من يطّلع عليها أيضاً
فقط ما يحتاجه كل طرف لأداء عمله:
- **الموردون** الذين يسلّمون المنتج يحصلون على البيانات اللازمة له (مثل معرّف اللاعب).
- **خدمات الدفع** (شام كاش، نجوم تيليجرام، شبكة البلوكشين لعملة USDT) تعالج مدفوعاتك وفق شروطها.
- **مزوّدو الاستضافة وتسجيل الدخول** (Cloudflare وSupabase) و**تيليجرام** لتشغيل المتجر.
- **الجهات الرسمية** عندما يفرض القانون ذلك.

## ملفات تعريف الارتباط والتخزين
نستخدم ملف تعريف ارتباط واحداً لإبقائك مسجلاً للدخول، وتخزين المتصفح لتذكّر لغتك والمظهر. لا نستخدم ملفات إعلانية أو للتتبع.

## مدة الاحتفاظ
بيانات حسابك طالما حسابك موجود. الطلبات والمدفوعات طوال المدة التي تتطلبها المحاسبة والقانون، حتى بعد إغلاق الحساب.

## خياراتك
يمكنك أن تطلب نسخة من بياناتك أو تصحيحها أو حذف حسابك. تواصل معنا عبر الوسائل أدناه؛ وقد نحتفظ بالسجلات التي يلزمنا القانون بالاحتفاظ بها.

## الأطفال
المتجر غير موجّه للأطفال دون 13 عاماً. لبعض الألعاب والخدمات حدود عمرية خاصة بها، فالتزم بها.

## التغييرات
قد نحدّث هذه السياسة؛ ويظهر تاريخ آخر نسخة في هذه الصفحة. وسنعلن التغييرات المهمة في المتجر.

## التواصل
{contact}`;

const termsEn = `These terms apply when you use {store} at {site} or in Telegram. By creating an account or buying, you accept them.

## The store
We sell digital products: game top-ups, gift cards and codes, subscriptions, virtual phone numbers for verification codes, and similar products. Brand names and logos belong to their owners; we are not affiliated with them unless we say so. Each product also follows its publisher's own rules.

## Your account
- Keep your Telegram, email or Google login safe: what happens in your account is your responsibility.
- Don't use the store for anything illegal, or in a way that breaks a game's or a service's rules.
- We may suspend an account used for fraud, abuse or payment disputes.

## Your wallet
- You buy from your wallet balance, in US dollars, and you top it up with the payment methods shown in the store.
- A top-up is added once its payment is confirmed. A payment made after its time window, or with a different amount, may need to be checked by hand.
- Your balance is for purchases in the store. It is not a bank account, earns no interest and can't be moved to another account.

## Prices
Prices are in US dollars and may change at any time; you pay the price shown when you confirm. Amounts shown in other currencies are only a guide.

## Orders and delivery
- Most products are delivered automatically within moments. Products marked "by hand" are delivered by our team, usually within the time shown on the product.
- You must enter the right details (player ID, server, account…). We deliver to the details you entered.
- If we can't deliver an order, its full amount goes back to your wallet.

## Virtual numbers
A number receives the verification code of the service you chose, for a limited time. If no code arrives, you can report it in the order and get another number or your money back to your wallet, as the order shows. Numbers are temporary: don't use them for accounts you will need to recover later.

## Refunds
See our [refund policy]({url}/legal/refund).

## Invites and coupons
Invite rewards and coupons follow the rules shown in the store. We may cancel rewards gained through abuse (for example fake accounts).

## Our responsibility
We do our best to keep the store working and to deliver what you buy. We are not responsible for problems caused by a game or service itself (outages, bans, changes), or by wrong details you entered. Where the law allows, our responsibility for an order is limited to the amount you paid for it.

## Changes
We may update these terms; the date on this page shows the latest version. Using the store after a change means you accept the new version.

## Contact
{contact}`;

const termsAr = `تنطبق هذه الشروط عند استخدامك {store} على {site} أو في تيليجرام. بإنشاء حساب أو الشراء فإنك توافق عليها.

## المتجر
نبيع منتجات رقمية: شحن الألعاب، البطاقات والأكواد، الاشتراكات، أرقام هواتف مؤقتة لاستلام رموز التحقق، ومنتجات مشابهة. الأسماء التجارية والشعارات ملك لأصحابها، ولا نتبع لهم ما لم نذكر ذلك. ويخضع كل منتج أيضاً لقواعد الجهة المالكة له.

## حسابك
- حافظ على أمان دخولك عبر تيليجرام أو البريد أو جوجل: ما يجري في حسابك مسؤوليتك.
- لا تستخدم المتجر لأي أمر غير قانوني، أو بطريقة تخالف قواعد لعبة أو خدمة.
- قد نوقف أي حساب يُستخدم للاحتيال أو إساءة الاستخدام أو نزاعات الدفع.

## محفظتك
- تشتري من رصيد محفظتك بالدولار الأمريكي، وتشحنه بطرق الدفع الظاهرة في المتجر.
- يُضاف الشحن بعد تأكيد الدفع. والدفع بعد انتهاء مهلته أو بمبلغ مختلف قد يحتاج إلى مراجعة يدوية.
- رصيدك مخصص للشراء من المتجر؛ ليس حساباً بنكياً، ولا يحقق أرباحاً، ولا يمكن نقله إلى حساب آخر.

## الأسعار
الأسعار بالدولار الأمريكي وقد تتغير في أي وقت؛ وتدفع السعر الظاهر عند تأكيد الطلب. المبالغ المعروضة بعملات أخرى للاسترشاد فقط.

## الطلبات والتسليم
- تُسلَّم أغلب المنتجات تلقائياً خلال لحظات. أما المنتجات المعلَّمة "يدوي" فيسلّمها فريقنا، عادةً خلال المدة الظاهرة على المنتج.
- عليك إدخال البيانات الصحيحة (معرّف اللاعب، الخادم، الحساب…). نسلّم إلى البيانات التي أدخلتها.
- إن تعذّر تسليم طلب، يعود مبلغه كاملاً إلى محفظتك.

## الأرقام المؤقتة
يستقبل الرقم رمز التحقق للخدمة التي اخترتها، لمدة محدودة. إن لم يصل الرمز يمكنك الإبلاغ من داخل الطلب والحصول على رقم آخر أو استرداد المبلغ إلى محفظتك، كما يظهر في الطلب. الأرقام مؤقتة: لا تستخدمها لحسابات ستحتاج إلى استعادتها لاحقاً.

## الاسترداد
راجع [سياسة الاسترداد]({url}/legal/refund).

## الدعوات والكوبونات
تخضع مكافآت الدعوات والكوبونات للقواعد الظاهرة في المتجر. وقد نلغي المكافآت الناتجة عن إساءة الاستخدام (مثل الحسابات الوهمية).

## مسؤوليتنا
نبذل جهدنا ليبقى المتجر يعمل ولتسليم ما تشتريه. لسنا مسؤولين عن المشاكل التي تسببها اللعبة أو الخدمة نفسها (أعطال، حظر، تغييرات)، ولا عن البيانات الخاطئة التي أدخلتها. وفي حدود ما يسمح به القانون، تقتصر مسؤوليتنا عن أي طلب على المبلغ الذي دفعته مقابله.

## التغييرات
قد نحدّث هذه الشروط؛ ويظهر تاريخ آخر نسخة في هذه الصفحة. واستمرارك في استخدام المتجر بعد التغيير يعني موافقتك على النسخة الجديدة.

## التواصل
{contact}`;

const refundEn = `Digital products are delivered at once and can't be sent back, so this policy explains when you get your money back. Refunds go to your {store} wallet, so you can use them right away.

## You get your money back when
- **An order fails or can't be delivered:** the full amount goes back to your wallet automatically.
- **A product sells out or stops** after you paid and before it was delivered: the amount goes back to your wallet.
- **A virtual number gets no code:** report it in the order, then take another number or get your money back, as the order shows.
- **A product doesn't work when delivered** (for example a code that was already used): contact us within 48 hours with the order number and a screenshot. We check with the supplier, then replace it or refund it.
- **A product with a warranty** (shown on its page) stops working during the warranty: we replace it or refund it, as its warranty says.

## No refund when
- The order was delivered to the details you entered, and they were wrong (player ID, server, account…).
- A delivered code works, or a top-up arrived in the game.
- You changed your mind after delivery.
- The game or service banned or limited your account for breaking its rules.

## Wallet top-ups
The balance you add can be used for any product. If you paid by mistake (for example a wrong amount), contact us with the payment details and we will sort it out. Returning balance to the original payment method is possible only in special cases, at our discretion, minus any transfer fees.

Payments made with Telegram Stars also follow Telegram's rules: for a payment problem, send /paysupport to our bot.

## How to ask
Send us your order number and what went wrong. We usually answer within a day.
{contact}`;

const refundAr = `تُسلَّم المنتجات الرقمية فوراً ولا يمكن إرجاعها، لذا توضح هذه السياسة متى تسترد أموالك. يُعاد المبلغ إلى محفظتك في {store} لتستخدمه مباشرة.

## تسترد أموالك عندما
- **يفشل الطلب أو يتعذّر تسليمه:** يعود المبلغ كاملاً إلى محفظتك تلقائياً.
- **ينفد المنتج أو يتوقف** بعد الدفع وقبل التسليم: يعود المبلغ إلى محفظتك.
- **لا يصل رمز إلى الرقم المؤقت:** أبلغ عن ذلك من داخل الطلب، ثم خذ رقماً آخر أو استرد المبلغ، كما يظهر في الطلب.
- **لا يعمل المنتج عند تسليمه** (مثل كود مستخدم مسبقاً): تواصل معنا خلال 48 ساعة مع رقم الطلب ولقطة شاشة. نتحقق مع المورّد ثم نستبدله أو نعيد المبلغ.
- **يتوقف منتج له ضمان** (يظهر في صفحته) خلال مدة الضمان: نستبدله أو نعيد المبلغ حسب شروط ضمانه.

## لا يوجد استرداد عندما
- يُسلَّم الطلب إلى البيانات التي أدخلتها وكانت خاطئة (معرّف اللاعب، الخادم، الحساب…).
- يعمل الكود المسلَّم، أو يصل الشحن إلى اللعبة.
- تغيّر رأيك بعد التسليم.
- تحظر اللعبة أو الخدمة حسابك أو تقيّده لمخالفة قواعدها.

## شحن المحفظة
يمكن استخدام الرصيد الذي تضيفه لشراء أي منتج. إن دفعت بالخطأ (مثل مبلغ خاطئ) تواصل معنا مع تفاصيل الدفع وسنعالج الأمر. أما إعادة الرصيد إلى وسيلة الدفع الأصلية فممكنة في حالات خاصة فقط، وفق تقديرنا، بعد خصم رسوم التحويل إن وُجدت.

المدفوعات بنجوم تيليجرام تخضع أيضاً لقواعد تيليجرام: لأي مشكلة في الدفع أرسل /paysupport إلى البوت.

## كيف تطلب الاسترداد
أرسل لنا رقم الطلب وما الذي حدث. نرد عادةً خلال يوم.
{contact}`;

export const DEFAULT_PAGES: DefaultPage[] = [
  { slug: "terms", titleAr: "الشروط والأحكام", titleEn: "Terms of service", bodyAr: termsAr, bodyEn: termsEn, sort: 10 },
  { slug: "privacy", titleAr: "سياسة الخصوصية", titleEn: "Privacy policy", bodyAr: privacyAr, bodyEn: privacyEn, sort: 20 },
  { slug: "refund", titleAr: "سياسة الاسترداد", titleEn: "Refund policy", bodyAr: refundAr, bodyEn: refundEn, sort: 30 },
];
