// הגדרות החיבור ל-Supabase.
// את שני הערכים מעתיקים מ: Supabase > Project Settings > API
// מפתח ה-anon מיועד לדפדפן ומותר לפרסם אותו. ההגנה על הנתונים היא מדיניות ה-RLS שבקובץ supabase/schema.sql.
// לעולם לא לשים כאן את מפתח ה-service_role.
window.TRIP_CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-ANON-KEY',
  ENABLE_GOOGLE: false   // true אחרי שמפעילים את ספק Google ב-Supabase > Authentication > Providers
};
