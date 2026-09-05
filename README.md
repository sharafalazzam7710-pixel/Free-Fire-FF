# Free Fire Clash Squad

منصة عربية متجاوبة باتجاه RTL لتنظيم بطولات **Free Fire Clash Squad**، مع تسجيل الفرق، جدول المباريات، النتائج، ولوحة إدارة محمية.

## هل يعمل على GitHub Pages؟

نعم، الواجهة الأمامية يمكن بناؤها ونشرها على GitHub Pages. ملف
`.github/workflows/deploy-pages.yml` ينفّذ البناء تلقائيًا عند الدفع إلى فرع
`main`، ويستخدم مسارات نسبية ونسخة `404.html` حتى تعمل مسارات الواجهة مثل
`/admin/login` عند إعادة تحميل الصفحة.

لكن GitHub Pages خدمة ملفات ثابتة فقط؛ لذلك لا يمكن تشغيل الخادم أو PostgreSQL
عليها. الواجهة تعتمد على API في:

- `backend/` — خادم Express ومسارات البطولة.
- `packages/db/` — مخطط PostgreSQL وDrizzle ORM.

لتعمل التسجيلات ولوحة الإدارة بعد نشر الواجهة، انشر `backend/` على خدمة تدعم
Node.js وقاعدة PostgreSQL، ثم أضف متغير Repository variable باسم
`VITE_API_BASE_URL` يحتوي على رابط الخادم، مثل:

```text
https://api.example.com
```

لا تضع `DATABASE_URL` أو `ADMIN_ACCESS_TOKEN` أو أي سر داخل GitHub. استخدم
متغيرات البيئة في خدمة استضافة الخادم.

## التشغيل محليًا

المشروع يستخدم pnpm workspaces وNode.js:

```bash
pnpm install
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/free-fire-clash-squad run dev
```

للبناء المحلي:

```bash
pnpm run typecheck
PORT=4173 BASE_PATH=./ pnpm --filter @workspace/free-fire-clash-squad run build
```

يتم إخراج الواجهة المبنية إلى:

```text
frontend/dist/public/
```

المتغيرات المطلوبة للخادم:

- `DATABASE_URL` — رابط قاعدة PostgreSQL.
- `SESSION_SECRET` — سر الجلسات عند الحاجة.
- `ADMIN_ACCESS_TOKEN` — رمز الإدارة في الإنتاج.

في التطوير يقبل الخادم الرمز التجريبي `demo-admin-access`. لا تستخدمه في
الإنتاج.

## بنية المشروع

```text
free-fire-clash-squad/
├── frontend/                  # React + Vite: الموقع ولوحة الإدارة
│   ├── public/                # favicon وrobots.txt
│   ├── src/
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── pages/
│   │   ├── App.tsx
│   │   ├── index.css
│   │   └── main.tsx
│   ├── index.html
│   ├── package.json
│   └── vite.config.ts
├── backend/                   # Express API — لا يعمل على GitHub Pages
│   └── src/
├── packages/
│   ├── api-client-react/      # hooks وعميل API للواجهة
│   ├── api-spec/              # مصدر عقد OpenAPI
│   ├── api-zod/               # مخططات التحقق
│   └── db/                    # PostgreSQL/Drizzle schema
├── extras/mockup-sandbox/     # ملفات النموذج الأصلي المحفوظة للمرجعية
├── scripts/
├── .github/workflows/
│   └── deploy-pages.yml
├── .env.example
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

## ملاحظات مهمة

- لم يتم تغيير مكونات الواجهة أو الألوان أو تدفق الوظائف الأصلية.
- تم تغيير تنظيم المجلدات فقط، وإزالة ملفات إعداد Replit غير اللازمة للنشر
  على GitHub.
- روابط ملفات البناء والصور نسبية لتعمل تحت مسار مستودع GitHub Pages.
- مسار التنقل الداخلي يضبطه Workflow تلقائيًا حسب اسم المستودع عبر
  `VITE_ROUTER_BASE`.
- `VITE_API_BASE_URL` اختياري محليًا؛ عند تركه فارغًا تُستخدم مسارات API
  النسبية من نفس النطاق.
- عند تعديل `packages/api-spec/openapi.yaml`، أعد توليد ملفات العميل والمخططات
  قبل البناء:

```bash
pnpm --filter @workspace/api-spec run codegen
```
