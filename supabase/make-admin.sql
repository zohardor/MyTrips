-- =====================================================================
--  הגדרת מנהל: גישה מלאה לכל הטיולים, היומנים, התמונות והמשתמשים
--  שלב 1: נרשמים לאתר עם המייל של המנהל (או יוצרים משתמש ב-
--          Authentication > Users > Add user, עם Auto Confirm).
--  שלב 2: מחליפים את המייל למטה ומריצים ב-SQL Editor.
-- =====================================================================

insert into public.admins (user_id)
select id from public.profiles where lower(email) = lower('admin@example.com')
on conflict (user_id) do nothing;

-- בדיקה: מי המנהלים כרגע
select p.email, p.full_name, a.added_at
from public.admins a join public.profiles p on p.id = a.user_id;

-- הסרת הרשאת מנהל (להריץ רק כשצריך):
-- delete from public.admins
-- where user_id = (select id from public.profiles where lower(email) = lower('admin@example.com'));
