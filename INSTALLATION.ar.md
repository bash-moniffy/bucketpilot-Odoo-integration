# تثبيت BucketPilot على Odoo 18

**العربية** · [English](INSTALLATION.en.md)

## قبل التثبيت

- استخدم خادم Odoo 18 يدعم تطبيقات Python المخصصة، مثل Community أو Enterprise المستضاف على خادمك.
- جهّز مساحة عمل على BucketPilot، وBucket متصل، ومفتاح API. لإنشاء النسخ، استخدم مفتاحًا بصلاحية القراءة والكتابة.
- يحتاج خادم Odoo إلى حزمتي Python ‏`Jinja2` و`requests`.

## 1. إضافة التطبيق إلى Odoo

1. اطلب من مسؤول الخادم وضع مجلد تطبيق `bucketpilot` داخل أحد مسارات إضافات Odoo وإعادة تشغيل الخدمة. لازم يكون ملف `__manifest__.py` موجودًا داخل مجلد `bucketpilot` مباشرةً.
2. استخدم حساب مسؤول إعدادات Odoo لنسخ الـ filestore. تحتاج خدمة Odoo لصلاحية قراءة الـ filestore والكتابة في مجلد بياناتها الدائم.
3. فعّل **Developer Mode** في Odoo، ثم افتح **Apps → Update Apps List**. ابحث عن **BucketPilot** واضغط **Activate**.
4. افتح **BucketPilot** من مبدّل التطبيقات في Odoo.

## 2. ربط الحساب وإنشاء أول نسخة

1. افتح **BucketPilot → Connection**. أدخل مفتاح API الخاص بـBucketPilot واضغط **Validate and connect**.
2. افتح **Backups**. أدخل اسمًا للنسخة، وحدد الـBucket ومجلد الوجهة، واختر الملفات أو المجلدات من **Filestore root**. أول مستوى بيعرض المجلدات اللي مسموح لقاعدة البيانات توصلها. افتح المجلد لاختيار ملفات محددة أو اختَر **Entire current folder** لنسخ كل الملفات المتاحة فيه.
3. اختَر **Run Now** أو حدّد موعد النسخ، وبعدها راجع الاختيارات وأكّدها.
4. تابع النتيجة في **Backup History**. مهمة **BucketPilot: Process backup requests** في Odoo بتعالج الطلب حتى لو سكّرت المتصفح. بأول تجربة، استخدم ملف عيّنة غير حساس في تثبيت تجريبي منفصل وBucket مأذون للتجربة عليه.

الملفات اللي بتختارها كل واحد لحاله بتنرفع مباشرة داخل مجلد التاريخ بالوجهة. إذا اخترت مجلد، بتنحفظ المسارات داخل المجلد.

الـ filestore بيحتوي المرفقات المحفوظة على القرص بأسماء Odoo الداخلية. سجلات PostgreSQL والمرفقات المخزّنة داخل قاعدة البيانات بتحتاج نسخة من قاعدة البيانات. تثبيت Git اختياري للخادم وغير مطلوب لتشغيل BucketPilot.

**إذا بتحدّث من إصدار باكاب ملفات المشروع:** افتح كل جدولة بدك تحتفظ فيها، اختَر الملفات أو المجلدات من المصدر الحالي، واحفظها من جديد. للتشغيل مرة ثانية لباكاب قديم لمرة واحدة، أنشئ باكاب جديد.

## إعدادات اختيارية على الخادم

**السماح بنسخ الـ filestore بالكامل.** افتراضيًا كل قاعدة بتقدر تنسخ مجلدها داخل الـ filestore. حتى تسمح لمسؤولي إعدادات Odoo في قاعدة موثوقة بتصفّح ونسخ الـ filestore كله، اضبط `BUCKETPILOT_FILESTORE_ADMIN_DB` في بيئة خدمة Odoo على اسم هالقاعدة. مثلًا، تحت `services → odoo → environment` في Docker Compose:

```yaml
BUCKETPILOT_FILESTORE_ADMIN_DB: bucketpilot
```

استخدم الإعداد لقاعدة بتعطيها صلاحية على كل الملفات الموجودة في الـ filestore، وأعد تشغيل Odoo بعد تغييره.

**اختيار مجلد بديل عند الحاجة.** افتراضيًا BucketPilot بيقرأ من `<data_dir>/filestore` حسب إعدادات Odoo. خلي `BUCKETPILOT_PROJECT_ROOT` فاضي أو غير معرّف حتى تستخدم هاد الافتراضي. إذا مسؤول الخادم بده يختار مجلد معتمد ثاني، يضيف مساره المطلق لبيئة خدمة Odoo. مع Docker Compose، أضف السطر تحت `services → odoo → environment` وحطّ قيمة المسار في ملف `.env` الخاص بالمشروع:

```yaml
BUCKETPILOT_PROJECT_ROOT: ${BUCKETPILOT_PROJECT_ROOT:-}
```

مع Docker، استخدم المسار زي ما بيظهر داخل الحاوية، واربط المجلد وأعطِ خدمة Odoo صلاحية قراءته. المسار البديل مشترك بين القواعد اللي بتخدمها نفس خدمة Odoo. اختَر مجلد مخصص فيه الملفات المسموح نسخها فقط. BucketPilot ما بيطبّق قواعد `.gitignore`.

**إنشاء مجلد المفتاح يدويًا عند الحاجة.** عادةً BucketPilot بينشئ `bucketpilot-secrets` داخل مجلد بيانات Odoo الدائم (`data_dir`) لما تحفظي مفتاح API صالح. إذا تعذّر الإنشاء، تأكدي إن Odoo بيقدر يكتب في `data_dir`. مع Docker، هاد الأمر بينشئ المجلد بصلاحيات خاصة لمستخدم خدمة Odoo:

```sh
docker compose exec -T --user root odoo install -d -m 0700 -o odoo -g odoo /var/lib/odoo/bucketpilot-secrets
```

حطّي الإعداد الاختياري التالي تحت نفس قسم `environment`. خلي المجلد على تخزين دائم وخارج مجلد ملفات النسخ.

```yaml
BUCKETPILOT_SECRET_DIRECTORY: /var/lib/odoo/bucketpilot-secrets
```

على Linux بدون Docker، استخدمي `sudo install -d -m 0700 -o odoo -g odoo /srv/odoo-private/bucketpilot-secrets` مع اسم مستخدم ومجموعة خدمة Odoo الفعليين، واضبطي `BUCKETPILOT_SECRET_DIRECTORY` على نفس المسار في بيئة الخدمة.

طبّقي تغييرات Compose بالأمر `docker compose up -d odoo`، أو أعيدي تشغيل خدمة Odoo إذا كانت تعمل مباشرة على الخادم. إذا أنشأتي مجلد المفتاح أو غيّرتيه، احفظي مفتاح API مرة ثانية من **Connection**.

## تقارير البريد الاختيارية

اضبط سيرفر إرسال مفعّل من **Odoo Settings → Emails → Outgoing Email Servers** واستخدم **Test Connection**. حدّد المستلِم في حقل **Email** للشركة الرئيسية من **Settings → Users & Companies → Companies**. تأكد من عنوان المستلِم وحالة SMTP من **BucketPilot → Connection → Backup email notifications**.
