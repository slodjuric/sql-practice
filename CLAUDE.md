# SQL Practice

Web aplikacija za vježbanje SQL upita — interaktivni zadaci s provjerom direktno na PostgreSQL bazi, sa login/role sistemom (admin / mentor-"Professor" / student), sesijama (planovima učenja) i podrškom za više practice dataset-a.

> **Napomena za AI asistente:** ovaj fajl je poslednji put usklađen sa kodom 2026-07-06. Ako nešto ovdje izgleda sumnjivo staro u odnosu na kod koji vidiš, vjeruj kodu i (ako je moguće) ažuriraj ovaj fajl u istom PR-u.

## Pokretanje

### Backend
```bash
cd backend
npm run dev       # nodemon, port 3001
# ili
npm start         # node, port 3001
```
Backend **odbija da se pokrene** bez `SESSION_SECRET` u `backend/.env` (fail-fast, vidi `src/index.js`).

### Frontend
```bash
cd frontend
npm run dev       # Vite dev server, port 3000 (vidi frontend/vite.config.js — NIJE Vite-ov default 5173)
```
Vite proxy-uje `/api/*` na `http://localhost:3001` (hardkodovano u `vite.config.js`, nema `VITE_API_URL` env varijable u projektu).

Oba servisa moraju biti pokrenuta istovremeno.

## Arhitektura

```
sql-practice/
├── backend/
│   ├── src/
│   │   ├── index.js          # Express server, CORS, express-session (connect-pg-simple), globalni error handler
│   │   ├── db.js             # PostgreSQL pool (pg)
│   │   ├── initDb.js         # Idempotentne migracije za "app" tabele (public shema) — pokreće se pri svakom boot-u
│   │   ├── data/
│   │   │   ├── taskRegistry.js        # Merge-uje tasks.json iz SVIH dataset-a; throws na duplicate/malformed id
│   │   │   └── datasets/
│   │   │       ├── academic/tasks.json   # 221 zadatak — JEDINI dataset sa sadržajem
│   │   │       ├── cinema/tasks.json     # [] — schema+podaci postoje, zadataka NEMA
│   │   │       ├── football/tasks.json   # [] — schema+podaci postoje, zadataka NEMA
│   │   │       └── nation/tasks.json     # [] — schema+podaci postoje, zadataka NEMA
│   │   ├── routes/            # vidi "Backend route map" ispod
│   │   └── utils/             # vidi "Check-answer flow" i "Role/permission model" ispod
│   ├── db/
│   │   ├── schemas/academic.sql   # DROP+CREATE+INSERT za academic shemu (7 tabela) — ovo pokreće `npm run db:init`
│   │   ├── init-practice-db.sql   # STARIJA verzija istog, kreira tabele u `public` shemi — NE koristi se više za setup, ostavljen kao referenca
│   │   └── legacy/                 # arhivirane, jednokratne migracione skripte — nikad se ne pokreću u normalnom radu
│   └── .env                  # DB + SESSION_SECRET konfiguracija (ne commitovati)
└── frontend/
    └── src/
        ├── App.jsx            # Top-level controller — auth state, session state, viewedUser (review mode), navigacija (nema router lib, ručni currentView switch)
        ├── api.js             # fetch wrapperi; userId/role se NIKAD ne šalju eksplicitno — backend ih čita iz session cookie-ja
        └── components/        # vidi "Frontend component map" ispod
```

## Baza podataka

- PostgreSQL, baza: `sql_practice`, port: 5432.
- Konfiguracija u `backend/.env` (vidi `.env.example`); podržava i `DATABASE_URL` (koriste ga samo `run-sql-file.js` i `check-setup-flow.js` — glavna app konekcija u `src/db.js` **uvijek** gradi konekciju iz `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD`, `DATABASE_URL` tu nije podržan).
- Dvije "vrste" šema u istoj bazi:
  - `public` — app/progress tabele (`users`, `learning_sessions`, `learning_session_filters`, `task_attempts`, `user_task_progress`, `datasets`, `mentor_assignments`) — kreira i migrira `initDb.js` **automatski pri svakom startu backend servera**. Ne diraj ove tabele ručno.
  - Po jedna shema po dataset-u (`academic`, `cinema`, `football`, `nation`) — practice podaci za vježbanje, kreiraju se ručno preko `npm run db:init` (samo `academic`) ili preko `npm run dataset:*` pipeline-a (cinema/football/nation).

Inicijalizacija `academic` practice tabela (jednom, ili kad god želiš resetovati samo practice podatke):
```bash
cd backend && npm run db:init
```
Ovo pokreće `backend/scripts/run-sql-file.js`, koji **default-uje na `backend/db/schemas/academic.sql`** (DROP+CREATE+INSERT za 7 tabela: `faculties, departments, professors, subjects, students, exams, professor_subjects`, sve u `academic` shemi). `backend/db/init-practice-db.sql` je starija verzija koja je pravila iste tabele u `public` shemi — više se ne koristi u normalnom setup-u, ostavljena je samo kao istorijska referenca (`initDb.js` čak ima migraciju koja pri boot-u briše te stare `public.*` tabele ako postoje). **Ne diraj** tabele za napredak (`users`, `learning_sessions`, itd.) — te kreira `initDb.js` automatski.

Provjera konekcije:
```bash
curl http://localhost:3001/api/health
```

## Auth / session model

- Pravi login: `bcryptjs` hash (`users.password_hash`, cost 10), `express-session` + `connect-pg-simple` (sesije se čuvaju u Postgres-u, tabelu kreira automatski — `createTableIfMissing: true`).
- Cookie: `httpOnly`, `sameSite: 'lax'`, `secure` samo kad je `NODE_ENV=production`, rolling 14 dana.
- `POST /api/auth/login` — generička poruka greške ("Invalid username or password") bez obzira da li nalog ne postoji, nema password_hash, ili je pogrešna lozinka (sprječava enumeraciju naloga). Na uspjeh: `req.session.regenerate()` PRIJE upisa `userId` (mitigacija session fixation-a).
- `GET /api/auth/me` — svaki put nanovo čita `role`/`username` iz baze na osnovu `req.session.userId` (ništa se ne kešira u samom session payload-u osim `userId`) — promjena role ili brisanje naloga djeluje odmah na sljedećem requestu.
- **Admin može resetovati lozinku bilo kog korisnika iz UI-ja** — `PATCH /api/users/:id/password` (admin-only, `requireRole('admin')`), inline forma u `UserManagementView.jsx` ("Reset password" dugme po redu, uključujući admin-ov sopstveni red — resetovanje lozinke nije destruktivno kao delete, pa se namjerno ne skriva za sopstveni red). Password pravila (`MIN_PASSWORD_LENGTH = 8`, `BCRYPT_COST = 10`, hash/validate helperi) su centralizovana u `backend/src/utils/passwordPolicy.js`, koriste je i `POST /api/users` i `scripts/set-user-password.js`. Radi identično za legacy naloge sa `password_hash IS NULL` (bezuslovni `UPDATE`, isti obrazac kao CLI skripta) — nakon reseta korisnik se odmah može ulogovati. **Namjerno van scope-a za sada:** self-service change (ulogovani korisnik mijenja SVOJU lozinku), forgot-password/email/token flow, generisanje privremene lozinke, force-change-on-next-login, invalidacija postojećih sesija nakon reseta, audit log admin akcije — sve ostaje CLI-only ili nepostojeće dok se eksplicitno ne zatraži.
- **CLI i dalje postoji i radi** za slučajeve kad UI nije dostupan (npr. bootstrap prvog admina, direktan DB/server pristup): `node scripts/set-user-password.js <username> <newPassword>` (min. 8 karaktera, bcrypt hash, nikad ne printa raw password/hash).
- **Bootstrap prvog admin naloga nije skriptovan.** `initDb.js` seeduje samo jedan `'default'` user, role `student` (default), bez password_hash-a. Da bi postojao prvi admin nalog, trenutno je potrebna ručna DB izmjena:
  ```sql
  UPDATE users SET role = 'admin' WHERE username = 'default';
  ```
  a zatim:
  ```bash
  node scripts/set-user-password.js default <newPassword>
  ```
  Ovo je poznato ograničenje, ne featura — ako se doda "prava" seed/bootstrap skripta u budućnosti, ažuriraj ovaj odjeljak.

## Role/permission model

Tri role, DB `CHECK` constraint na `users.role`: `admin | mentor | student`. **`mentor` se u UI-ju prikazuje kao "Professor"** (`frontend/src/utils/roleLabels.js`) — DB vrijednost ostaje `mentor` svuda, ne postoji zaseban `professor` role string.

| Akcija | admin | mentor ("Professor") | student |
|---|---|---|---|
| Vidi sopstvene sesije/progress | da | da | da |
| Vidi sesije/progress drugog (assigned) korisnika | da (bilo koji user) | da, samo ako postoji red u `mentor_assignments` za tog studenta | ne |
| Kreira sesiju za sebe | da | da | **ne, nikad** |
| Kreira sesiju za assigned studenta | da | da | n/a |
| Edituje/preimenuje sesiju | da (bilo koju) | da, svoju ili assigned studentovu | **ne, nikad** |
| Reopen završene sesije | da (bilo koju) | da, svoju ili assigned studentovu | **ne, nikad** |
| Complete sesije | n/a (self-only ruta) | n/a (self-only ruta) | da, samo svoju, ako su svi taskovi iz plana pokrenuti bar jednom |
| Briše sesiju | da (bilo koju) | da, svoju ili assigned studentovu | **ne, nikad** |
| Upravlja korisnicima (`/api/users`) | da | ne | ne |
| Upravlja mentor↔student assignment-ima (`/api/mentor-assignments`) | da | ne (samo read-only `/api/mentor/students` za svoje) | ne |
| Vidi svoje dodijeljene studente | n/a | da (`GET /api/mentor/students`) | n/a |
| Fetch-uje solution zadatka | da | da | da (login-only, nema role gate) |

Logika je centralizovana u `backend/src/utils/authz.js`:
- `getActingUser(req)` — jedini izvor identiteta, čita **isključivo** `req.session.userId` (stari `x-acting-user-id` header mehanizam je potpuno uklonjen).
- `requireRole(...roles)` — middleware, 401 (nema acting user) / 403 (pogrešna rola).
- `canAccessUser(actingUser, targetUserId)` — account-level check (admin ili self), **ne koristi se** za sesije/progress.
- `canAccessStudent(actingUser, studentId)` — pravi izvor istine za mentor/student cross-access (admin uvijek; self uvijek; mentor samo ako postoji `mentor_assignments` red).
- `canCreateSessionForUser` — kao `canAccessStudent`, ali eksplicitno blokira `role === 'student'` čak i za self-creation.
- `canReopenSession` — admin uvijek; mentor preko `canAccessStudent`; student nikad (ni za sopstvenu sesiju).
- `canViewSession(actingUser, session)` — wrapper oko `canAccessStudent(actingUser, session.user_id)`.

**Nema posebne "assignment" (homework) ili "review mode" tabele.** "Assignments" u imenu funkcionalnosti znači *mentor↔student* vezu (`mentor_assignments` tabela, ko je nečiji mentor), ne dodjelu zadataka. "Review mode" znači da mentor/admin gleda postojeće sesije/progress studenta preko `?targetUserId=` na istim GET rutama koje student koristi za sebe — nema posebne review-status/komentar tabele.

### Brisanje korisnika (`DELETE /api/users/:id`)

Admin-only (`requireRole('admin')`), **permanentno, hard-delete** — nema soft-delete/arhive za naloge (za razliku od sesija, vidi Archive/restore ispod). Poziva se iz dva mjesta u frontendu: `Sidebar.jsx`-ov "delete my account" (self-delete, postojeći flow) i `UserManagementView.jsx`-ov "Delete" u tabeli korisnika (brisanje **drugog** korisnika — dugme se namjerno **ne prikazuje** za red trenutno ulogovanog admina, da se izbjegne dupliranje sa self-delete flow-om).

Šta se tačno dešava (`backend/src/routes/users.js`):
- **Guard protiv brisanja poslednjeg admina** — ako je meta jedini preostali `admin`, vraća 400, ništa se ne mijenja.
- Sesije koje obrisani korisnik **posjeduje** (`learning_sessions.user_id`) se **trajno brišu**, zajedno sa svojim `task_attempts` i `user_task_progress` redovima (eksplicitno u ruti, transakciono).
- Sesije koje je obrisani korisnik samo **kreirao** za nekog drugog (`created_by_user_id`, npr. mentor koji je setapovao plan za studenta) **ostaju netaknute** — samo `created_by_user_id` postaje `NULL` (`ON DELETE SET NULL`, migracija u `initDb.js`). Vlasnik (`user_id`) i njegov progress se nikad ne diraju.
- `mentor_assignments` redovi (i kao `mentor_id` i kao `student_id`) se čiste automatski na DB nivou (`ON DELETE CASCADE`), bez posebnog koda u ruti.
- Test pokrivenost: `scripts/check-authz.js` (admin-only gate + owned-session cascade), `scripts/check-session-creator-delete.js` (creator-only slučaj, `created_by_user_id` → NULL), `scripts/check-mentor-assignments-schema.js` case 05 (mentor_assignments cascade).

## VAŽNA INVARIJANTA — activeUser vs viewedUser

- `activeUser` (frontend `App.jsx` state) = **stvarni ulogovani korisnik**, izvor istine je `GET /api/auth/me` → backend session. Sve Run Query / Check Answer akcije MORAJU ostati skopirane na `activeUser` + `activeSession`.
- `viewedUser` (frontend `App.jsx` state) = **samo UI kontekst** ("koga mentor/admin trenutno pregleda"), NIKAD acting identitet. Postavlja se kad mentor klikne studenta u My Students, ili admin klikne "Review" u User Management.
- `PracticeView`/`TaskView` dobijaju `viewedUser` **isključivo kao display-only prop** (za banner "Running or checking here affects only your own account") — nikad se ne šalje kao `targetUserId` u `/api/tasks/:id/check` ili `/api/query`. Ako ikad vidiš da neki API poziv iz Practice/TaskView šalje `viewedUser.id` kao identitet za run/check — to je bug, ne feature.
- Backend NIKAD ne vjeruje klijentskom identitetu za autorizaciju — `targetUserId` (gdje god postoji, npr. `GET /api/sessions`, `GET /api/progress/summary`) se uvijek re-autorizuje server-side preko `canAccessStudent`, nezavisno od toga šta frontend šalje.
- Frontend role-based UI (npr. `activeUser.role !== 'student'` provjere u `Sidebar.jsx`/`ProgressView.jsx`) je **kozmetički**, samo da se ne prikazuju dugmad koja bi svakako vratila 403. Prava granica je uvijek backend (`requireRole`, `canX` funkcije). **Ne vjeruj frontend role provjerama kao security granici kad dodaješ novi kod — uvijek dodaj i backend provjeru.**

## Sessions/plans model

Korisnik (student) ima jednu ili više `learning_sessions` (plan učenja). Ključna polja:
- `user_id` — **vlasnik** sesije, čiji se progress/attempts prate.
- `created_by_user_id` — **ko je sesiju kreirao** (mentor/admin koji je setapovao plan za studenta, ili sam student/self-creation). `ON DELETE SET NULL` — brisanje kreatora nikad ne briše/blokira brisanje same sesije.
- `plan_type`: `'topic'` | `'category'` | `'project'` (napomena: stariji tekst je pominjao i `'level'` kao poseban plan_type — to više ne postoji kao opcija u frontend `PLAN_TYPE_OPTIONS`; difficulty filter i dalje radi kao nezavisan AND-gate preko svih plan_type-ova).
- `status`: `'active'` | `'completed'` — **completion state**, nezavisno od archived (vidi ispod).
- `archived_at` / `archived_by_user_id` — **lifecycle visibility**, ortogonalno na `status`. `NULL` = normalna, vidljiva sesija (default za sve postojeće i nove sesije). Postavljeno = sesija je arhivirana: sakrivena je iz default `GET /api/sessions` liste, ali `task_attempts`/`user_task_progress`/`learning_session_filters`/ownership/`completed_at`/`last_opened_at`/`dataset_id` ostaju potpuno netaknuti. `archived_by_user_id` prati `ON DELETE SET NULL` isti obrazac kao `created_by_user_id`.
- `last_opened_at` — ažurira se ISKLJUČIVO preko self-only `PATCH /:id/open` rute (nikad kad mentor/admin samo pregleda tuđu sesiju — frontend to namjerno nikad ne poziva u viewedUser kontekstu). Blokirano (403) ako je sesija arhivirana.
- Filteri u `learning_session_filters` (`filter_type`: topic/difficulty/project/category, `filter_value`).

Mentor može kreirati/editovati/arhivirati/restore-ovati/reopenovati sesiju za dodijeljenog studenta (preko opcionog `targetUserId` u body-u), ali to se UVIJEK re-autorizuje server-side (`canCreateSessionForUser`/`canAccessStudent`/`canArchiveSession`) — nikad se ne vjeruje samom postojanju `targetUserId` polja. Student nikad ne može kreirati/editovati/arhivirati/restore-ovati/brisati/reopenovati sesiju, čak ni svoju — može je samo birati (selektovati aktivnu) i **completovati** (jedina management-slična akcija dozvoljena studentu, uz uslov da su svi taskovi iz plana pokrenuti bar jednom).

### Archive / restore (normalan način "uklanjanja" sesije)

**Archive je normalan, user-facing način da se sesija ukloni iz vidljive liste — ne DELETE.** Uveden jer je hard-delete (cascade brisanje `task_attempts`/`user_task_progress`/`learning_session_filters`) nepovratno gubio istoriju/napredak studenta na jedan pogrešan klik.

- `PATCH /api/sessions/:id/archive` — postavlja `archived_at = NOW()`, `archived_by_user_id = actingUser.id`. Autorizacija: `canArchiveSession` (admin bilo koju; mentor svoju ili dodijeljenog studenta; student nikad — isti blanket gate kao edit/delete).
- `PATCH /api/sessions/:id/restore` — čisti `archived_at`/`archived_by_user_id`. Ista autorizacija kao archive. **Ne mijenja `status` ni `last_opened_at`** — restore ne čini sesiju automatski aktivnom, korisnik je i dalje mora eksplicitno izabrati.
- `GET /api/sessions` — default isključuje arhivirane (`WHERE archived_at IS NULL`). `?includeArchived=true` vraća i arhivirane (koristi ih Sidebar-ov "Show archived sessions" toggle).
- Dok je sesija arhivirana: `PATCH /:id` (edit), `PATCH /:id/complete`, `PATCH /:id/reopen`, `PATCH /:id/open` sve vraćaju 403 sa jasnom porukom ("This session is archived. Restore it..."). Reopen i restore su namjerno odvojene akcije — reopen je za completed→active, restore je za archived→vidljivo; arhivirana+completed sesija se prvo restore-uje, zatim (po potrebi) reopen-uje.
- `POST /api/tasks/:id/check` i `POST /api/query` (Run Query) takođe blokiraju (403) izvršavanje protiv arhivirane sesije, isti obrazac kao postojeći `status === 'completed'` guard.
- `contextResolvers.resolveSessionId`'s "no sessionId provided → pick user's first session" fallback isključuje arhivirane sesije (`AND archived_at IS NULL`) — arhivirana sesija se nikad ne "vaskrsava" kao aktivna samo zato što caller nije eksplicitno tražio drugu.

### Hard delete — trajna akcija, dostupna u UI uz Archive

`DELETE /api/sessions/:id` je trajni hard-delete, nepromijenjene autorizacije (student nikad; mentor svoju/dodijeljenog studenta; admin bilo koju) — permanentno uništava `task_attempts`/`user_task_progress`/`learning_session_filters`/samu sesiju, bez mogućnosti undo-a. Archive i Delete su namjerno dva odvojena dugmeta u `Sidebar.jsx`-ovoj session-controls traci (🗄 Archive, 🗑 Delete), oba vidljiva samo za `activeUser.role !== 'student'` — isti gate kao Archive/Create, student ih nikad ne vidi. Delete NE zamjenjuje Archive: Archive ostaje default, restorabilan, non-destructive način uklanjanja sesije iz vidljive liste (vidi gore); Delete je za slučajeve kad se sesija stvarno treba trajno ukloniti (npr. pogrešno kreiran test plan). Delete-ova potvrda (`window.confirm`) eksplicitno navodi šta se briše i da je nepovratno: `Delete session "<name>" permanently? This will delete its attempts, progress, and plan filters. This cannot be undone.` — namjerno destruktivnija formulacija od Archive-ove potvrde. Nakon uspješnog delete-a, `App.jsx`-ov `handleDeleteSession` (dijeli `removeSessionAndPickNext` helper sa `handleArchiveSession`) uklanja sesiju iz liste i bira sljedeću dostupnu sesiju (ili prazno stanje ako nema više).

## Dataset/task sistem

- `backend/src/data/datasets/<key>/tasks.json` — po jedan fajl po dataset-u.
- `backend/src/data/taskRegistry.js` — pri boot-u čita SVE `datasets/*/tasks.json`, validira da je `id` numerički i globalno jedinstven (throws na duplicate/malformed), tag-uje svaki task sa `datasetKey` (iz naziva foldera, ako task sam ne definiše `datasetKey`). Ovo je stvarni, aktivni kod — koriste ga `routes/tasks.js`, `routes/sessions.js`, `routes/progress.js`.
- **Trenutno stanje sadržaja — samo `academic` ima zadatke:**

  | Dataset | Broj zadataka | Napomena |
  |---|---|---|
  | `academic` | 221 | Jedini dataset sa sadržajem — koristi ga cijeli postojeći task breakdown ispod. |
  | `cinema` | 0 | Schema + CSV podaci + import pipeline postoje (`raw/`, `csv/`, `dataset.config.json`), **zadataka nema**. |
  | `football` | 0 | Isto — schema+podaci postoje, zadataka nema. |
  | `nation` | 0 | Isto — schema+podaci postoje, zadataka nema. |

  **Ne pretpostavljaj da je bilo koji od cinema/football/nation spreman za vježbanje** — trenutno bi student koji izabere jedan od njih vidio prazan task list svuda. Session-creation dataset picker u `Sidebar.jsx` trenutno NE filtrira dataset-e bez zadataka.

- `academic` breakdown (jedini populisan dataset, 221 zadatak):

  | Kategorija | topicId | Broj | Težine |
  |---|---|---|---|
  | SELECT basics | select | 11 | easy |
  | WHERE filtering | where | 13 | easy–hard |
  | ORDER BY sorting | sorting | 2 | easy |
  | Aggregate functions | aggregate-functions | 15 | easy–hard |
  | GROUP BY | group-by-having | 10 | medium–hard |
  | HAVING | group-by-having | 6 | medium |
  | INNER JOIN | join | 17 | easy–hard |
  | LEFT JOIN | join | 3 | medium–hard |
  | Subqueries | subqueries | 15 | easy–hard |
  | Mixed practice | — | 1 | hard |
  | Sorting | sorting | 12 | easy–hard |
  | CASE WHEN | case-when | 12 | easy–hard |
  | Set Operations | set-operations | 10 | easy–hard |
  | CTE | cte | 12 | easy–hard |
  | Window Functions | window-functions | 15 | easy–hard |
  | Date Functions | date-functions | 10 | easy–hard |
  | Text Functions | text-functions | 12 | easy–hard |
  | Data Analysis | data-analysis | 15 | easy–hard |
  | Practice Projects | — | 30 | hard |

  LevelId vrijednosti: `introduction`, `beginner`, `intermediate`, `advanced`, `expert`. Practice Projects imaju `projectId` (ne `topicId`): `student-performance`, `faculty-analysis`, `subject-difficulty`, `professor-workload`, `exam-timeline` (po 6 zadataka svaki).

  Svaki zadatak ima: `id`, `datasetKey`, `category`, `topicId` ili `projectId`, `levelId`, `difficulty`, `title`, `description`, `hint`, `solution`, `tables[]`. Opciono: `requiresOrderBy` (bool), `validationMode` (`'strict'` | `'result_only'`) — **trenutno nijedan od 221 zadatka ne postavlja `validationMode` eksplicitno** (vidi "Check-answer flow" ispod za implikacije).

- Dataset build pipeline (koristi se za nove/prazne dataset-e, ne za `academic`, koji je ručno pisan SQL): `npm run dataset:generate-config` → `dataset:build-sample` → `dataset:import` → `dataset:reset`. Detalji: [`docs/adding-new-dataset.md`](docs/adding-new-dataset.md).

**Ne mijenjati `tasks.json` fajlove** bez eksplicitnog zahtjeva.
**Ne exposovati `solution` SQL frontendu** osim preko eksplicitne, login-gated `/api/tasks/:id/solution` rute — svuda drugo samo izvedeni booleani kao `solutionHasJoin`.

## Backend route map

| Mount | Fajl | Rute | Auth |
|---|---|---|---|
| `/api/auth` | `routes/auth.js` | `POST /login`, `POST /logout`, `GET /me` | javno (login/logout), `/me` provjerava session |
| `/api/users` | `routes/users.js` | `GET /`, `POST /`, `DELETE /:id`, `PATCH /:id/password` | admin-only (`requireRole('admin')`) |
| `/api/sessions` | `routes/sessions.js` | `GET /` (`?includeArchived=true` opciono), `POST /`, `PATCH /:id`, `GET /:id/filters`, `PATCH /:id/complete`, `PATCH /:id/reopen`, `PATCH /:id/open`, `PATCH /:id/archive`, `PATCH /:id/restore`, `DELETE /:id` (trajni hard-delete, dostupan u UI uz Archive — vidi "Hard delete" ispod) | login required; ownership/role provjere po ruti (vidi tabelu gore i "Archive / restore" ispod) |
| `/api/datasets` | `routes/datasets.js` | `GET /` (lista aktivnih dataset-a) | javno (samo metadata) |
| `/api/tables` | `routes/tables.js` | `GET /`, `GET /:name/columns`, `GET /:name/preview` | scoped na session-ov dataset schema |
| `/api/query` | `routes/query.js` | `POST /` (Run Query / playground) | **login required uvijek**, bez obzira na `taskId` — vidi "Poznati rizici" ispod |
| `/api/tasks` | `routes/tasks.js` | `GET /categories`, `GET /`, `GET /:id`, `GET /:id/solution` (login required), `POST /:id/check` | vidi check-answer flow ispod |
| `/api/progress` | `routes/progress.js` | `GET /summary`, `GET /tasks-status` | login required; `?targetUserId=` re-autorizovan preko `canAccessStudent` |
| `/api/mentor-assignments` | `routes/mentorAssignments.js` | `GET /`, `POST /`, `DELETE /:id` | admin-only |
| `/api/mentor` | `routes/mentorStudents.js` | `GET /students` | mentor-only, uvijek samo `req.actingUser`-ov roster |

## Frontend component map

| Fajl | Uloga |
|---|---|
| `App.jsx` | Top-level controller — auth state, session state, `viewedUser` (review mode), navigacija. Nema router lib, `currentView` string + switch. Heavy prop drilling (nema Context API u projektu). |
| `api.js` | fetch wrapperi; `credentials: 'same-origin'`; userId/role se nikad ne šalju eksplicitno osim opcionog `targetUserId`. |
| `components/LoginView.jsx` | Login forma. |
| `components/Sidebar.jsx` | Navigacija + session switcher (custom dropdown) + create/archive/**delete**/complete/reopen session forma + "Show archived sessions" toggle sa Restore dugmetom + DB tree + account (self-delete/logout). Archive (🗄) i Delete (🗑) su odvojena dugmad jedno pored drugog, oba admin/mentor-only — Delete ne zamjenjuje Archive. Veliki, multi-responsibility fajl (~750+ linija) — pažljivo čitaj cijeli fajl prije izmjene. |
| `components/PracticeView.jsx` | Topic/level/project kartice → task list → `TaskView`. |
| `components/TaskView.jsx` | Editor (CodeMirror), Run Query / Check Answer, hint/solution, `CheckBanner` (specifična poruka po `failureReason`). |
| `components/QueryPlayground.jsx` | Slobodan SQL sandbox — dijeli safety/timeout/row-limit logiku sa `/api/tasks/:id/check`, ali odvojena ruta. |
| `components/DatabaseView.jsx` | Table browser (Data/Columns tabovi). |
| `components/ProgressView.jsx` | Progress dashboard: summary, by-group breakdown, recent attempts, in-progress taskovi, plan editor. Veliki, multi-responsibility fajl (~825 linija, uključuje inline `EditPlanForm` i `SessionSummaryCard`) — pažljivo čitaj cijeli fajl prije izmjene. |
| `components/UserManagementView.jsx` | Admin: user create/list/**delete**/**reset password** (delete permanentno, dugme skriveno za sopstveni red — self-delete i dalje ide preko `Sidebar.jsx`; reset password NIJE skriven za sopstveni red, inline row-expansion forma, jedna otvorena odjednom) + mentor↔student assignment upravljanje. **Još nema** edit-role za postojeće naloge (van scope-a). |
| `components/MyStudentsView.jsx` | Mentor: lista sopstvenih dodijeljenih studenata. |
| `components/MentorOverviewView.jsx` | Admin koji pregleda mentora: prikazuje mentorov student roster umjesto mentorovih (obično irelevantnih) sesija. |
| `components/ResultTable.jsx`, `SqlEditor.jsx`, `TablePreviewPanel.jsx`, `CheckboxGroup.jsx`, `FormSelect.jsx`, `shared/StatusBadge.jsx` | Manje, reusable komponente. |
| `utils/taskFilters.js` | `matchesSessionFilters` — **namjerno duplirano** sa backend verzijom, vidi odjeljak ispod. |
| `utils/roleLabels.js` | `mentor` → "Professor" mapiranje (jedino mjesto koje to radi). |
| `utils/studentRoster.js` | `fetchStudentStats` — dijeli je `MyStudentsView` i `MentorOverviewView` (2 API poziva po studentu, paralelno; nema backend "roster summary" endpoint). |

## Check-answer flow (`POST /api/tasks/:id/check`)

Detaljna dokumentacija: [`docs/check-answer-flow.md`](docs/check-answer-flow.md).

1. Provjera sigurnosti SQL-a (`sqlSafetyValidator.validateSqlSafety`) — samo SELECT/WITH dozvoljen, plus keyword blocklist (`drop, delete, update, insert, alter, truncate, create, grant, revoke, merge, call, execute, copy`). **Poznato ograničenje:** ovo je text-based keyword scan, ne parser — `SELECT ... INTO <table>` trenutno NIJE blokiran (ne sadrži nijednu blokiranu riječ), i ne postoji poseban read-only DB role/transaction kao backup sloj — cijela "read-only" garancija trenutno leži na ovom jednom sloju.
2. `sqlSafetyValidator.validateSchemaScope` — blokira reference na shemu DRUGOG dataset-a (cross-dataset izolacija).
3. Paralelno izvršavanje preko `queryRunner.js`: `executeUserQuery(userSql, schemaName)` (dedicated pool client, `SET statement_timeout` + `SET search_path`, reset u `finally`) + `executeSolutionQuery(task.solution, schemaName)` (bez timeout-a — solution je trusted).
4. Timeout catch: `err.code === '57014'` → friendly poruka (default 5s, env `QUERY_TIMEOUT_MS`).
5. Row limit check: ako `userResult.rowCount > ROW_LIMIT` (default 1000, env `QUERY_ROW_LIMIT`) → 400 error **prije** `compareResults` (sprječava false-positive match na ogromnom rezultatu).
6. `resultComparator.compareResults(userResult, solutionResult, { orderMatters })` — `orderMatters` se računa iz `solutionHasTopLevelOrderBy(task.solution)` (depth-aware — ignoriše ORDER BY unutar CTE/subquery/`OVER(...)`), NE iz `topicId === 'sorting'`.
7. Ako `isCorrect`: `sqlStructureValidator.validateRequiredOrderBy(userSql, task.solution, task)` — provjerava SAMO prisustvo top-level ORDER BY (ne i ispravnost kolone/smjera), uvijek se pokreće bez obzira na `validationMode`.
8. Ako `isCorrect` I `validationMode === 'strict'`: `sqlStructureValidator.validateSqlStructure(userSql, task.solution, task)` — hand-rolled, string-based struktura provjera (WHERE uslovi, DISTINCT, LIMIT, ORDER BY) koja se **namjerno** povlači na "valid" (bez prigovora) čim naiđe na `OR`, `IN`, `BETWEEN`, `IS NULL`, `ILIKE`, subquery ili CTE u WHERE-u — false negative je prihvatljiviji od false positive-a.
9. Zapis pokušaja u DB (`attemptRecorder.saveCheckAttempt`), vraćanje rezultata.

**VAŽNO — `validationMode` default i stvarni domet strukturne provjere:** `validationMode` default je `(['select','where'].includes(task.topicId)) ? 'strict' : 'result_only'`, a **nijedan od 221 zadatka trenutno ne postavlja `validationMode` eksplicitno**. To znači da korak 8 (strukturna provjera) **stvarno radi samo za ~24/221 zadatka (`select`+`where` topicId, ~11%)**. Za preostalih ~89% zadataka (join, group-by, subqueries, CTE, window-functions, itd.) tačnost se procjenjuje ISKLJUČIVO preko `compareResults` (jednakost rezultata) + `validateRequiredOrderBy` (prisustvo ORDER BY). Ne pretpostavljaj da je "structural cheating" (npr. suvišan/izostavljen WHERE uslov koji slučajno da isti rezultat) hvatan za sve zadatke — nije.

## Poznati rizici / na šta paziti

- **Frontend role provjere nisu security granica.** `activeUser.role !== 'student'` i slične provjere u `Sidebar.jsx`/`ProgressView.jsx`/`App.jsx` su kozmetičke — prava granica je `backend/src/utils/authz.js` + `requireRole`/`canX` provjere po ruti, uvijek iznova izvedene iz session cookie-ja + DB lookup-a. Kad dodaješ novu role-gated akciju, provjera MORA postojati na backend-u — frontend gate je opciona UX poboljšica, ne supstitut.
- **`matchesSessionFilters` postoji u dvije kopije** — `frontend/src/utils/taskFilters.js` i `backend/src/utils/taskFilters.js` (koristi je `progress.js`). Moraju ostati identične logike — neusklađenost tiho prikazuje različite task setove u Practice vs Progress za istu sesiju. Ako mijenjaš filter logiku u jednom fajlu, primijeni identičnu izmjenu u drugom.
- **`ProgressView.jsx` i `Sidebar.jsx` su veliki, multi-responsibility fajlovi** (~855 i ~780 linija, oba dalje porasla dodavanjem archive/restore UI-ja) — prije bilo kakve izmjene, pročitaj cijeli fajl, ne pretpostavljaj da je odgovornost jasno odvojena unutar njega.
- **Nema automatizovanih frontend/e2e testova** (nema Playwright-a, nema unit testova, nema `test` skripte u `frontend/package.json`). `activeUser`/`viewedUser` review-mode granica (vidi invarijantu gore) je trenutno zaštićena SAMO ručnim testiranjem i komentarima u kodu — **ne dodavaj nove role/review featur-e prije nego što postoji bar osnovni frontend test oko ove granice**, jer regresija ovdje nije samo UI bug nego security-adjacent bug.
- **SQL safety sloj ima poznatu rupu** (`SELECT ... INTO`, vidi Check-answer flow gore) i nema DB-level backup (nema restricted/read-only role). Budi oprezan kad proširuješ query execution putanje (`queryRunner.js`, `query.js`, `tasks.js`) — ne pretpostavljaj da je "samo SELECT" garantovano na nivou baze, garantovano je samo na nivou ovog jednog validatora.
- `POST /api/query` zahtijeva login uvijek (401 `{ "error": "Authentication required" }` bez sesije), bez obzira na `taskId` — prethodno je radilo i neulogovano kad `taskId` nije poslan (najveća neautentikovana površina u API-ju), popravljeno. Pokriveno testom `test:query-tasks-authz` (case 5b + cases 7-9 za student/mentor/admin bez `taskId`-ja).
- User lifecycle UI je i dalje djelimično kompletan — admin sad može kreirati, brisati **i resetovati lozinku** korisnika (`UserManagementView.jsx`, sve admin-only), ali još nema edit-role za postojeće naloge.
- **Brisanje korisnika je permanentno i hard-delete** — briše sve sesije/task_attempts/user_task_progress koje taj korisnik **posjeduje** (vidi `routes/users.js` `DELETE /:id`). Sesije koje je taj korisnik samo **kreirao** za nekog drugog (mentor za studenta) ostaju netaknute, samo im `created_by_user_id` postaje `NULL` (`ON DELETE SET NULL`, vidi initDb.js). `mentor_assignments` redovi se čiste automatski na DB nivou (`ON DELETE CASCADE` na oba pravca). Nema soft-delete/arhive za naloge — ako se ovo pokaže preriskantnim, razmisliti o `deleted_at` pristupu prije nego što broj korisnika poraste.
- Cinema/football/nation dataset-i su selektabilni pri kreiranju sesije iako nemaju zadataka (vidi Dataset/task sistem gore) — ne pretpostavljaj da su spremni za produkciju/demo dok se ne doda sadržaj ili se picker ne filtrira.

## Query safety limits

`backend/src/utils/queryRunner.js` — `executeUserQuery(sql, schemaName)`:
- Acquires dedicated pool client.
- `SET statement_timeout = QUERY_TIMEOUT` (default: 5000ms, env: `QUERY_TIMEOUT_MS`).
- `SET search_path = <schemaName>, pg_catalog`.
- `finally` uvijek resetuje oba (`statement_timeout = 0`, `search_path = public, pg_catalog`) i oslobađa klijenta.
- Timeout → pg error code `57014`.
- Row limit (default: 1000, env: `QUERY_ROW_LIMIT`) provjerava **caller** (`tasks.js`/`query.js`), ne `queryRunner` samo.

`/api/query`: row limit check → 400 error; timeout → 400 error.
`/api/tasks/:id/check`: row limit check fires **prije** `compareResults` (sprječava false-positive match).

Solution SQL uvijek radi preko `executeSolutionQuery` — bez timeout-a (isti `search_path`, bez row limita jer je trusted).

## Verification scripts

Sve žive u `backend/scripts/`, pokreću se preko `npm run test:*` (nema Jest/Mocha — svaka skripta je samostalan Node program sa `pass`/`fail` printer-om, `process.exit(1)` na failure). Podjela:

**Pure-logic (bez DB, instant):**
```bash
cd backend
npm run test:sql-validator        # SQL structure validator
npm run test:compare-results      # Result comparator
npm run test:sql-safety           # SQL safety validator
npm run test:order-detection      # ORDER BY detection
npm run test:required-order-by    # ORDER BY enforcement scope
```

**Live-DB auth/authz/behavior (zahtijevaju pravu Postgres konekciju i `backend/.env`):**
```bash
npm run test:auth                    # login/logout/me
npm run test:password-hashing        # bcrypt hashing/verifikacija
npm run test:authz                   # DELETE /api/users/:id authz + owned-session cascade (task_attempts/user_task_progress/session all removed)
npm run test:authz-helpers           # canAccessUser/canAccessStudent/canCreateSessionForUser/canViewSession
npm run test:users-admin-gate        # GET/POST /api/users admin-only gate
npm run test:user-password-reset     # PATCH /api/users/:id/password authz + behavior + legacy NULL-hash case
npm run test:users-role              # role assignment/validacija
npm run test:reopen-authz            # PATCH /:id/reopen admin/mentor/student matrica
npm run test:session-ownership       # osnovna session CRUD izolacija
npm run test:session-create-for-user # POST /api/sessions sa targetUserId
npm run test:session-read-for-user   # GET /api/sessions sa targetUserId
npm run test:session-creator-delete  # created_by_user_id ON DELETE SET NULL
npm run test:session-archive-authz   # archive/restore authz matrix, visibility, data-preservation, archived-guards
npm run test:sessions-read-authz     # GET /api/sessions + /:id/filters puna matrica
npm run test:sessions-write-authz    # create/update/complete/open/delete puna matrica (najveći suite)
npm run test:progress-authz          # GET /api/progress/* authz
npm run test:progress-read-for-user  # ?targetUserId= na progress rutama
npm run test:query-tasks-authz       # auth zahtjevi na /api/query i /api/tasks/:id/check
npm run test:query-limits            # row limit + timeout
npm run test:solution-authz          # GET /api/tasks/:id/solution zahtijeva login
npm run test:mentor-assignments-schema  # mentor_assignments shema + created_by_user_id migracija
npm run test:mentor-assignments-api     # admin CRUD na /api/mentor-assignments
npm run test:mentor-students            # GET /api/mentor/students mentor-only scoping
```

**End-to-end setup:**
```bash
npm run test:setup-flow    # kompletan setup flow na disposable test DB-u (DATABASE_URL=...sql_practice_e2e_test)
```

**Dataset tooling (nije test, operativne skripte):**
```bash
npm run dataset:generate-config -- <datasetKey>
npm run dataset:build-sample -- <datasetKey>
npm run dataset:import -- <datasetKey>
npm run dataset:reset -- <datasetKey>
```

Nema CI konfiguracije u repo-u koja bi ove skripte automatski pokretala — trenutno ih treba ručno pokrenuti prije nego što se vjeruje da neka izmjena nije pokvarila auth/checking logiku.

## Preporučeni sljedeći zadaci

1. **Popuni empty dataset picker problem** — ili filtriraj cinema/football/nation iz session-creation picker-a dok nemaju zadataka, ili napiši prvi set zadataka za jedan od njih.
2. **Dovrši user lifecycle UI** — delete i reset password su sad urađeni (`UserManagementView.jsx`, oba admin-only); preostaje još edit-role za postojeće naloge, i eventualno self-service password change (vidi Auth / session model gore za listu namjerno neimplementiranih password-related featura).
3. **Dodaj frontend review-mode testove** — pokrij `activeUser`/`viewedUser` granicu (vidi invarijantu gore) prije dodavanja novih role/review featura.
4. **Refaktoriši velike komponente** — izdvoji `EditPlanForm`/`SessionSummaryCard` iz `ProgressView.jsx`, i `SessionSwitcher`/`DbTreeNav`/`AccountPanel` iz `Sidebar.jsx`.
5. **Konsoliduj dupliranu filter logiku** — jedan izvor istine za `matchesSessionFilters` umjesto dvije ručno sinhronizovane kopije (frontend + backend).

## Development rules

- **Run non-destructive commands without asking**: npm scripts, node scripts, bash commands, SQL SELECT queries — run and report results directly. Ask only before destructive or irreversible actions (deleting data, dropping tables, force-push, deleting files).
- **Ne dodavati noisy console.log** u production code paths.
- **Ne dodavati `validationMode` u tasks.json globalno** — postavljati samo per-task gdje je potrebno.
- **Ne exposovati solution SQL frontendu** — samo izvedeni booleani (npr. `solutionHasJoin`), osim preko eksplicitne `/api/tasks/:id/solution` rute.
- **Ne vjeruj frontend role provjerama kao security granici** — svaka role-gated akcija mora imati odgovarajuću backend provjeru (`requireRole` ili `canX` iz `authz.js`).
- **Ne dodavaj nove role/review featur-e (npr. novu rolu, drugi nivo review-a) prije nego što postoji bar osnovni frontend test oko `activeUser`/`viewedUser` granice.**
- Komentare pisati samo za non-obvious WHY, ne za WHAT.
