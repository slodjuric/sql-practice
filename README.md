# SQL Practice

Interaktivna web aplikacija za učenje SQL-a na pravim PostgreSQL bazama — 221 zadatak (u trenutnom, glavnom dataset-u) s provjerom direktno na bazi, u browser SQL editorom, praćenjem napretka, sesijama (planovima učenja), podrškom za više dataset-a, i login/role sistemom (admin / mentor-"Professor" / student).

**Šta aplikacija radi:**
- Piši i izvršavaj SQL upite direktno u browseru (CodeMirror editor, sa autocomplete-om nad stvarnom šemom).
- **Run Query** — pokreni upit i vidi rezultat.
- **Check Answer** — provjeri upit protiv rješenja, sa konkretnom, specifičnom povratnom informacijom (ne samo tačno/netačno — npr. "pogrešan broj kolona", "poredak reda nije tačan", "WHERE uslov je previše restriktivan").
- Prati napredak po zadatku, po sesiji, po korisniku.
- Kreiraj više "sesija" (planova učenja) — po topic-u, kategoriji ili projektu, sa filterima po težini.
- Radi nad više practice dataset-a (trenutno: `academic` je jedini sa stvarnim zadacima — vidi "Dataset-i" ispod).
- Login sa lozinkom, tri role sa različitim ovlaštenjima (vidi "Role" ispod).

## Preduvjeti

| Alat | Minimalna verzija |
|------|------------------|
| Node.js | 18+ |
| npm | 9+ |
| PostgreSQL | 14+ |

Provjera instaliranih verzija:

```bash
node --version
npm --version
psql --version
```

---

## Postavljanje lokalno

### 1. Kloniraj repozitorij

```bash
git clone <repo-url>
cd sql-practice
```

### 2. Instaliraj zavisnosti

```bash
cd backend && npm install
cd ../frontend && npm install
```

### 3. Kreiraj bazu podataka

PostgreSQL mora biti pokrenut. Kreiraj praznu bazu:

```bash
createdb sql_practice
```

### 4. Konfiguriši konekciju

```bash
cp backend/.env.example backend/.env
```

Otvori `backend/.env` i popuni vrijednosti za tvoj lokalni PostgreSQL:

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=sql_practice
DB_USER=your_pg_username
DB_PASSWORD=your_pg_password
PORT=3001

# Obavezno — backend odbija da se pokrene bez ovoga (fail-fast provjera u src/index.js).
# Generiši pravu random vrijednost za lokalni .env, ne ostavljaj "change-me".
SESSION_SECRET=change-me
```

> `DB_PASSWORD` može ostati prazno ako tvoj PostgreSQL ne zahtijeva lozinku za lokalnog korisnika.

**Napomena o `DATABASE_URL`:** neke pomoćne skripte (`backend/scripts/run-sql-file.js`, `backend/scripts/check-setup-flow.js`) prihvataju i jedan `DATABASE_URL` connection string umjesto pojedinačnih `DB_*` varijabli, i daju mu prednost ako je postavljen. **Glavna aplikacija (`backend/src/db.js`) ovo ne podržava** — uvijek gradi konekciju isključivo iz `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD`. Za normalan rad aplikacije popuni `DB_*` varijable; `DATABASE_URL` je opcioni dodatak samo za te dvije skripte.

### 5. Inicijalizuj practice tabele (academic dataset)

```bash
cd backend
npm run db:init
```

Ova komanda pokreće `backend/scripts/run-sql-file.js`, koji **default-uje na `backend/db/schemas/academic.sql`** i:
- kreira 7 practice tabela u `academic` shemi: `faculties`, `departments`, `professors`, `subjects`, `students`, `exams`, `professor_subjects`
- puni ih demo podacima (90 studenata, 160 ispita, itd.)
- **ne dira** tabele za korisnički napredak i aplikacione podatke: `users`, `learning_sessions`, `task_attempts`, `user_task_progress`, `datasets`, `mentor_assignments` (njih kreira `initDb.js` automatski pri startu backend servera, u `public` shemi)

Možeš pokrenuti `db:init` ponovo u bilo kom trenutku da resetuješ samo `academic` practice podatke, bez gubitka korisničkih naloga, sesija ili napretka.

> **Napomena:** `backend/db/init-practice-db.sql` (fajl u korijenu `db/` foldera) je starija verzija koja je pravila iste tabele u `public` shemi umjesto u `academic` shemi. Više se **ne koristi** za normalan setup — `npm run db:init` je već preusmjeren na `db/schemas/academic.sql`. Fajl je ostavljen samo kao istorijska referenca; `initDb.js` čak ima migraciju koja pri startu servera briše stare `public.*` verzije ovih tabela ako postoje iz ranijeg setup-a.

### 6. Kreiraj prvi admin nalog

Login sistem je pravi (bcrypt + server-side sesije), ali **ne postoji skriptovani "bootstrap" prvog admin naloga** — `initDb.js` pri prvom startu servera kreira samo jedan `'default'` nalog, sa rolom `student` i bez lozinke. Da bi imao admin nalog za upravljanje korisnicima, potrebno je (nakon prvog starta backend servera, korak 8 ispod):

```bash
# 1. Ručno promijeni rolu 'default' naloga preko psql:
psql sql_practice -c "UPDATE users SET role = 'admin' WHERE username = 'default';"

# 2. Postavi mu lozinku preko CLI skripte (min. 8 karaktera):
cd backend
node scripts/set-user-password.js default <tvoja-lozinka>
```

Nakon ovoga se možeš ulogovati kao `default` (admin) i kreirati ostale naloge (mentor/student) direktno kroz User Management ekran u aplikaciji.

Da promijeniš ili resetuješ lozinku bilo kojem postojećem nalogu kasnije, koristi istu skriptu:
```bash
node scripts/set-user-password.js <username> <nova-lozinka>
```
Ne postoji "forgot password"/self-service reset u samoj aplikaciji — samo ova CLI skripta.

### 7. Pokreni aplikaciju

Otvori **dva** terminala:

```bash
# Terminal 1 — backend (port 3001)
cd backend
npm run dev
```

```bash
# Terminal 2 — frontend (port 3000)
cd frontend
npm run dev
```

Otvori [http://localhost:3000](http://localhost:3000).

> Vite dev server u ovom projektu je podešen na **port 3000** (`frontend/vite.config.js`), ne na Vite-ov default 5173. `/api/*` pozivi se automatski proksiraju na `http://localhost:3001` (isti fajl) — ne treba dodatna konfiguracija za lokalni rad.

### 8. Verifikacija

Opcionalno — potvrdi da je cjelokupni setup ispravan:

```bash
cd backend
npm run test:setup-flow
```

Ova skripta kreira privremenu test bazu, prolazi kroz kompletan setup flow (init → app tabele → kreiranje korisnika → sesija → pokušaj zadatka → drugi db:init), i briše test bazu na kraju.

---

## Role i ovlaštenja

Tri role: **admin**, **mentor** (u aplikaciji prikazan kao "Professor" — DB vrijednost ostaje `mentor`), **student**.

| Rola | Šta može |
|---|---|
| **Admin** | Upravlja korisnicima (kreira/briše naloge — vidi "Brisanje korisnika" ispod), upravlja mentor↔student vezama (ko je čiji mentor), može pregledati sesije/napredak bilo kog korisnika, arhivira/restore-uje/reopenuje bilo čiju sesiju. |
| **Mentor / "Professor"** | Vidi listu sebi dodijeljenih studenata, kreira/edituje/arhivira/restore-uje/reopenuje sesije (planove) za dodijeljene studente, pregleda njihov napredak. Ne može vidjeti/upravljati studentima koji mu nisu dodijeljeni. |
| **Student** | Rješava zadatke, bira među sebi dodijeljenim sesijama, prati sopstveni napredak. Ne može kreirati/editovati/arhivirati/reopenovati sesiju — jedina "upravljačka" akcija dozvoljena studentu je da svoju sesiju označi kao završenu (complete), pošto pokrene svaki zadatak iz plana bar jednom. |

Dodjeljivanje mentora studentu radi admin, u User Management ekranu ("Assignments" tab).

**Ove role provjere su stvarno enforced na backend-u** (ne samo skrivanje dugmadi u UI-ju) — svaki API poziv koji dira tuđe podatke (druga sesija, drugi korisnikov progress) se nezavisno re-autorizuje na serveru na osnovu ulogovanog korisnika iz sesije, ne na osnovu bilo čega što frontend pošalje.

---

## Brisanje korisnika — samo admin, trajno

U User Management ekranu ("Users" tab), admin sad ima dugme **Delete** za svaki red osim za sopstveni nalog:

- Dugme se **ne prikazuje** za trenutno ulogovanog admina — brisanje sopstvenog naloga i dalje ide preko posebnog "🗑" dugmeta u Sidebar-u (self-delete, postojeći, odvojen flow, sa sopstvenom potvrdom).
- Klik traži eksplicitnu potvrdu koja objašnjava šta se tačno dešava (ne generičko "Are you sure?"):
  - Sve sesije, napredak i istorija odgovora koje taj nalog **posjeduje** se **trajno brišu** — nema undo-a.
  - Sesije koje je taj korisnik samo **kreirao** za nekog drugog (npr. profesor koji je setapovao plan studentu) **ostaju netaknute** — samo prestaju da pokazuju ko ih je kreirao.
  - Za profesore, dodatna napomena da se i njihova dodjela studenata (assignments) uklanja.
- Nakon uspješnog brisanja: red nestaje iz tabele, prikazuje se poruka o uspjehu, a ako je taj korisnik trenutno pregledan (viewedUser u review modu), pregled se automatski zatvara.
- Mentor i student **ne vide** User Management ekran uopšte (ruta postoji samo za `activeUser.role === 'admin'`), i ne mogu obrisati korisnika ni direktnim API pozivom — `DELETE /api/users/:id` je admin-only na backend-u, nezavisno od frontenda.
- Admin ne može obrisati poslednjeg preostalog admin naloga (backend guard) — ovo sprječava potpuno zaključavanje platforme bez ijednog admina.

Detalji autorizacije, tačno ponašanje cascade-a (šta se briše, šta ostaje) i API oblik: [`CLAUDE.md`](CLAUDE.md#rolepermission-model).

---

## Sesije (planovi učenja) — archive umjesto delete

Uklanjanje sesije iz vidljive liste ide preko **Archive**, ne preko trajnog brisanja:

- Dugme u Sidebar-u ("🗄 Archive session") sakriva sesiju iz normalne liste, ali **čuva kompletnu istoriju** — sve `task_attempts` (pokušaji), `user_task_progress` (napredak po zadatku), filtere plana, vlasništvo/kreatora, `completed_at`, `last_opened_at` i dataset ostaju netaknuti u bazi.
- Arhivirane sesije se ne prikazuju u normalnom dropdown-u i ne mogu se pokrenuti/provjeriti (Run Query / Check Answer vraćaju jasnu grešku ako se na njih ipak pokuša).
- **"Show archived sessions"** toggle u Sidebar-u (vidljiv adminu/mentoru, ne studentu) prikazuje arhivirane sesije sa dugmetom **Restore** — restauracija vraća sesiju u normalnu listu, ali je ne bira automatski kao aktivnu.
- Ko smije arhivirati/restore-ovati: admin bilo koju sesiju; mentor svoju ili dodijeljenog studenta; student nikad (isto pravilo kao edit/reopen).
- **Trajno brisanje (`DELETE /api/sessions/:id`) i dalje postoji u backend-u, ali nije više dio normalnog UI flow-a** — nema dugmeta koje ga poziva. Ostaje isključivo za direktan API/DB-maintenance rad (npr. brisanje test naloga), jer nepovratno uništava istoriju pokušaja i napretka. Ne oslanjaj se na njega kao na način da "očistiš" sesiju — koristi Archive.

Detalji autorizacije i tačan API oblik: [`CLAUDE.md`](CLAUDE.md#sessionsplans-model).

---

## Dataset-i — trenutno stanje

Aplikacija podržava više practice dataset-a (svaki u svojoj PostgreSQL shemi), ali **trenutno samo jedan ima stvarne zadatke**:

| Dataset | Status | Broj zadataka |
|---|---|---|
| **academic** | Spreman za vježbanje | **221** |
| cinema | Samo infrastruktura — shema + podaci su uvezeni, **zadataka nema** | 0 |
| football | Samo infrastruktura — shema + podaci su uvezeni, **zadataka nema** | 0 |
| nation | Samo infrastruktura — shema + podaci su uvezeni, **zadataka nema** | 0 |

**Napomena:** ova tri "prazna" dataset-a se trenutno mogu izabrati kad se kreira nova sesija (session-creation picker ih ne filtrira), ali bi korisnik koji ih izabere vidio prazan task list svuda u Practice/Progress. Ako testiraš aplikaciju, koristi **academic** dataset za bilo koju sesiju koja treba da ima stvarne zadatke.

### Baza podataka — academic shema

```
faculties
  └── departments (faculty_id)
        ├── professors (department_id)
        ├── subjects   (faculty_id, department_id)
        └── students   (faculty_id, department_id)
              └── exams (student_id, subject_id, professor_id)

professor_subjects (professor_id, subject_id)
```

| Tabela | Redova |
|--------|--------|
| faculties | 6 |
| departments | 17 |
| professors | 10 |
| subjects | 48 |
| students | 90 |
| exams | 160 |
| professor_subjects | 50 |

Zadaci pokrivaju: SELECT basics, WHERE, Sorting, Aggregate Functions, GROUP BY/HAVING, JOIN, Subqueries, CASE WHEN, Set Operations, CTE, Window Functions, Date Functions, Text Functions, Data Analysis, i 5 Practice Projects (po 6 zadataka svaki).

---

## Arhitektura

- **Backend:** Node.js + Express + PostgreSQL (`pg`, bez ORM-a), autentikacija preko `express-session` + `connect-pg-simple` (sesije se čuvaju u samoj Postgres bazi) + `bcryptjs` za hash lozinki.
- **Frontend:** React + Vite, CodeMirror 6 za SQL editor. Nema router biblioteke (navigacija je ručna, preko internog view state-a).
- **PostgreSQL šeme:**
  - `public` — aplikacioni podaci (korisnici, sesije, progress, mentor-student veze) — kreira i migrira `initDb.js` automatski pri svakom startu backend servera.
  - Po jedna shema po practice dataset-u (`academic`, `cinema`, `football`, `nation`) — praktični podaci za vježbanje, kreiraju se ručno (vidi "Dodavanje novog dataset-a" ispod).

Detaljna arhitektura, backend route mapa, frontend component mapa, auth/role model i check-answer flow: [`CLAUDE.md`](CLAUDE.md).

---

## Rješavanje problema

**PostgreSQL nije pokrenut**
```
Error: connect ECONNREFUSED 127.0.0.1:5432
```
Pokreni PostgreSQL servis, npr. `brew services start postgresql` (macOS) ili `sudo service postgresql start` (Linux).

**Baza ne postoji**
```
Error: database "sql_practice" does not exist
```
Pokreni `createdb sql_practice` prije `npm run db:init`.

**Greška autentikacije (PostgreSQL)**
```
Error: password authentication failed for user "..."
```
Provjeri `DB_USER` i `DB_PASSWORD` u `backend/.env`.

**Backend se ne pokreće — "Missing required environment variable: SESSION_SECRET"**
Dodaj `SESSION_SECRET=<neka-random-vrijednost>` u `backend/.env` (vidi korak 4 gore) — backend namjerno odbija da se pokrene bez ovoga.

**"Invalid username or password" pri loginu, a nalog postoji**
Nalog nema postavljenu lozinku (`password_hash` je `NULL`) — ovo je uobičajeno za naloge kreirane prije login sistema. Postavi mu lozinku preko `node scripts/set-user-password.js <username> <lozinka>` (vidi korak 6 gore).

**Port već zauzet**
```
Error: listen EADDRINUSE :::3001
```
Promijeni `PORT` u `backend/.env`. Ako mijenjaš backend port, ažuriraj i `target` u `frontend/vite.config.js`-ovom `server.proxy['/api']` da odgovara novom portu.

**`.env` slučajno dodan u git**
`.env` je naveden u `.gitignore` i nikad ne smije biti commitovan. Ako jeste, ukloni ga iz git trackinga:
```bash
git rm --cached backend/.env
git commit -m "remove .env from tracking"
```
Rotiraj sve lozinke/secrete koji su bili u tom fajlu (uključujući `SESSION_SECRET`).

---

## Dodavanje novog dataset-a

See [docs/adding-new-dataset.md](docs/adding-new-dataset.md) for the full guide.

Quick summary: put source CSV files in `backend/src/data/datasets/<key>/raw/`, then run three commands from inside `backend/`:

```bash
npm run dataset:generate-config -- <datasetKey>
npm run dataset:build-sample -- <datasetKey>
npm run dataset:import -- <datasetKey>
```

The `csv/` folder is generated automatically — you do not create it manually. To undo and start over for one dataset: `npm run dataset:reset -- <datasetKey>`.

**Napomena:** ova skripta puni PostgreSQL shemu i tabele. Ne piše zadatke (`tasks.json`) — to se i dalje radi ručno, po dataset-u (vidi "Dataset-i — trenutno stanje" gore: ovo je razlog zašto cinema/football/nation trenutno imaju podatke ali nemaju zadatke).

---

## Check-answer flow

Kako `POST /api/tasks/:id/check` provjerava korisnikov SQL protiv rješenja (SQL safety validacija → izvršavanje → poređenje rezultata → strukturna validacija), uključujući poznata ograničenja: [docs/check-answer-flow.md](docs/check-answer-flow.md).

---

## Testiranje

**Backend** — veliki broj script-based provjera u `backend/scripts/`, pokreću se preko `npm run test:*` (nema Jest/Mocha, svaka skripta je samostalan Node program). Pokrivaju: SQL safety validaciju, poređenje rezultata, strukturnu validaciju, ORDER BY detekciju/enforcement, i veoma opsežan set autorizacionih scenarija (session ownership, mentor/student/admin matrica, admin-only gate-ovi, itd.). Puna lista skripti i šta svaka provjerava: [`CLAUDE.md`](CLAUDE.md#verification-scripts).

```bash
cd backend
npm run test:setup-flow          # end-to-end setup flow (zahtijeva živu DB konekciju)
npm run test:sql-validator       # SQL structure validator
npm run test:compare-results     # result comparator
npm run test:sql-safety          # SQL safety validator
npm run test:order-detection     # ORDER BY detection
npm run test:required-order-by   # ORDER BY enforcement scope
npm run test:sessions-write-authz  # najveći authz test suite (create/update/complete/open/delete matrica)
# ... i još ~20 test: skripti, vidi CLAUDE.md ili `cat backend/package.json`
```

**Frontend — trenutno nema automatizovanih testova.** Nema Playwright-a, nema unit/component testova, `frontend/package.json` nema `test` skriptu. Provjera frontend funkcionalnosti je trenutno isključivo ručna. Ovo je poznat, dokumentovan nedostatak (ne pretpostavljaj da testovi postoje ili da se pokreću u nekom CI-ju — CI konfiguracija za ovaj repo trenutno ne postoji).

---

## Napomene za developere

- `.env` fajl se ne commituje — za konfiguraciju koristi `.env.example` kao predložak.
- Stare razvojne skripte (`backend/db/legacy/01_create_tables.sql` itd.) su arhivirane i **ne koriste se** za normalni setup — koristi isključivo `npm run db:init`.
- `backend/db/init-practice-db.sql` je takođe stara/superseded verzija (vidi "Inicijalizuj practice tabele" gore) — ne koristi se, ostavljena je samo kao referenca.
- Aplikacija je trenutno na internom/MVP nivou zrelosti — pogodna za jednog nastavnika/mentora sa poznatim, malim brojem studenata na pouzdanoj lokalnoj/internoj mreži. Nije još pripremljena za javno/produkcijsko hostovanje bez dodatnog hardening-a (rate limiting na login, DB-level read-only enforcement za korisnički SQL, audit log, itd. — detalji u `CLAUDE.md`).
- Detalji arhitekture, backend route mapa, frontend component mapa, auth/role model, sessions/plans model, check-answer flow, i pravila za AI asistente: [`CLAUDE.md`](CLAUDE.md)
