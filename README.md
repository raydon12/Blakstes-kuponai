# Blakstės studija — dovanų kuponai

Сайт подарочных сертификатов: продажа онлайн, QR на каждом купоне, админка мастера со сканером и списаниями.

## Как устроено

- **Сайт** — один файл `public/index.html` (+ `public/vendor/`). Хостинг: Vercel, без сборки (`vercel.json`, папка `public`).
- **База** — отдельный проект Supabase «Blakstes kuponai» (`hermojruniqfvxksunrj`), не связан с NeeDo. Закрытая схема `kuponai` (таблицы `vouchers`, `staff`, `sessions`, `login_fails`).
  Сайт обращается к ней только через функции `kp_*` (файл `supabase/schema.sql`), поэтому все правила (минимум 40 €, нельзя списать больше остатка, только мастер видит купоны) проверяются в базе.
- Публичный ключ Supabase лежит в `index.html` (`#supa-config`). Это publishable-ключ, он предназначен для браузера.

## Мастера (вход в админку)

Админка: `https://<сайт>/#admin` или `/admin`. Вход по email и паролю (своя таблица `kuponai.staff`, пароль хранится только как bcrypt-хеш; 5 неверных попыток — блок на 10 минут; сессия 30 дней).

Добавить мастера (Supabase → SQL Editor):
```sql
insert into kuponai.staff(name, email, pw_hash)
values ('Имя', 'email@example.com', extensions.crypt('ПАРОЛЬ', extensions.gen_salt('bf')));
```
Сменить пароль:
```sql
update kuponai.staff set pw_hash = extensions.crypt('НОВЫЙ', extensions.gen_salt('bf')) where email = 'email@example.com';
```

## Оплата

Настоящей онлайн-оплаты пока нет. Онлайн-заказ создаёт купон со статусом «Laukia apmokėjimo» (ждёт оплаты): по нему нельзя списывать.
Когда клиент заплатил (перевод, наличные), мастер открывает купон и нажимает «Pažymėti apmokėtu». Купоны, проданные на кассе через «+ Naujas kuponas», сразу оплачены.
Письма клиентам пока не отправляются.

## Возможности

Магазин: выбор суммы через кнопку «Išsirinkti kuponą» (40–1000 €), поводы с готовым текстом, 4 дизайна, доставка себе или получателю в выбранный день, PNG и печать, проверка остатка по коду, FAQ, LT/RU.

Админка: статистика, график продаж за 30 дней, лента списаний, поиск, фильтры (в т.ч. «Neapmokėti»), сортировка, CSV, продажа на кассе, QR-сканер (камера или фото). В карточке: подтверждение оплаты, списание, отмена списания, +3 месяца, аннулирование/восстановление, PNG, правка данных. Все изменения пишутся в журнал купона.

## Прайс

Услуги задаются в `public/index.html` в блоке `<script id="menu-data">` (формат: `categories[].services[]` с полями `id, name, price, priceFrom, durationMin, description, bookingUrl`). Кнопка «Registruotis» ведёт на Treatwell.

## Локальный запуск без Supabase

`node server.js` (старый вариант с JSON-файлами в `data/`), открыть http://localhost:8080. Мастер: `node scripts/add-master.js <имя> <пароль>`.
