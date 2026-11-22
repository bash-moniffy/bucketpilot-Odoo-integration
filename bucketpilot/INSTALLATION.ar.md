# تثبيت BucketPilot على Odoo 18

**العربية** · [English](INSTALLATION.en.md)

## قبل التثبيت

- استخدم خادم Odoo 18 يدعم تطبيقات Python المخصصة، مثل Community أو Enterprise المستضاف على خادمك.
- جهّز مساحة عمل على BucketPilot، وBucket متصل، ومفتاح API. لإنشاء النسخ، استخدم مفتاحًا بصلاحية القراءة والكتابة.
- يحتاج خادم Odoo إلى Git وحزمتي Python ‏`Jinja2` و`requests`.

## 1. إضافة التطبيق إلى Odoo

1. اطلب من مسؤول الخادم وضع مجلد تطبيق `bucketpilot` داخل أحد مسارات إضافات Odoo وإعادة تشغيل الخدمة. لازم يكون ملف `__manifest__.py` موجودًا داخل مجلد `bucketpilot` مباشرةً.
2. أعطِ Odoo صلاحية قراءة ملفات المشروع والكتابة في مجلد بياناته الدائم.
3. فعّل **Developer Mode** في Odoo، ثم افتح **Apps → Update Apps List**. ابحث عن **BucketPilot** واضغط **Activate**.
4. افتح **BucketPilot** من مبدّل التطبيقات في Odoo.

## 2. ربط الحساب وإنشاء أول نسخة

1. افتح **BucketPilot → Connection**. أدخل مفتاح API الخاص بـBucketPilot واضغط **Validate and connect**.
2. افتح **Backups**. أدخل اسمًا للنسخة، وحدد الـBucket ومجلد الوجهة، واختر ملفات المشروع اللي بدك تنسخها.
3. اختَر **Run Now** أو حدّد موعد النسخ، وبعدها راجع الاختيارات وأكّدها.
4. تابع النتيجة في **Backup History**. مهمة **BucketPilot: Process backup requests** في Odoo بتعالج الطلب حتى لو سكّرت المتصفح. بأول تجربة، استخدم ملف عيّنة غير حساس في تثبيت تجريبي منفصل وBucket مأذون للتجربة عليه.

## إعدادات اختيارية على الخادم

**اختيار مجلد بداية قراءة الملفات.** BucketPilot بيكتشف جذر المشروع إذا كان ترتيبه قياسي، وبيطبّق قواعد `.gitignore`. إذا بدك تختاري مجلد ثاني مع Docker، عدّلي هالسطر في `compose.yaml` تحت `services → odoo → environment`:

```yaml
BUCKETPILOT_PROJECT_ROOT: ${BUCKETPILOT_PROJECT_ROOT:-/mnt/project}
```

استبدلي `/mnt/project` بالمسار المطلق زي ما بيشوفه Odoo جوّا الحاوية، أو اضبطي `BUCKETPILOT_PROJECT_ROOT` في ملف `.env` الخاص بـCompose. إذا شغّالة بدون Docker، أضيفي نفس المتغيّر لبيئة خدمة Odoo.

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
