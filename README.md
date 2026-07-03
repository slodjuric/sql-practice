# SQL Practice

Interaktivna web aplikacija za vježbanje SQL upita — 221 zadatak s provjerom direktno na PostgreSQL bazi.

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
```

> `DB_PASSWORD` može ostati prazno ako tvoj PostgreSQL ne zahtijeva lozinku za lokalnog korisnika.

**Alternativa — `DATABASE_URL`:** Ako preferiraš jedan connection string, dodaj ga u `.env` umjesto pojedinačnih varijabli:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/sql_practice
```

`run-sql-file.js` i `check-setup-flow.js` daju prednost `DATABASE_URL` ako je postavljen.

### 5. Inicijalizuj practice tabele

```bash
cd backend
npm run db:init
```

Ovo izvršava `backend/db/init-practice-db.sql` i:
- kreira 7 practice tabela: `faculties`, `departments`, `professors`, `subjects`, `students`, `exams`, `professor_subjects`
- puni ih demo podacima (90 studenata, 160 ispita, itd.)
- **ne diče** tabele za korisnički napredak: `users`, `learning_sessions`, `task_attempts`, `user_task_progress`

Možeš pokrenuti `db:init` ponovo u bilo kom trenutku da resetuješ samo practice podatke, bez gubitka korisničkih sesija ili napretka.

### 6. Pokreni aplikaciju

Otvori **dva** terminala:

```bash
# Terminal 1 — backend (port 3001)
cd backend
npm run dev
```

```bash
# Terminal 2 — frontend (port 5173)
cd frontend
npm run dev
```

Otvori [http://localhost:5173](http://localhost:5173).

> Tabele za korisnički napredak (`users`, `learning_sessions`, itd.) kreiraju se automatski
> pri prvom pokretanju backend servera — nema potrebe za ručnim pokretanjem.

### 7. Verifikacija

Opcionalno — potvrdi da je cjelokupni setup ispravan:

```bash
cd backend
npm run test:setup-flow
```

Ova skripta kreira privremenu test bazu, prolazi kroz kompletan setup flow (init → progress tabele → kreiranje korisnika → sesija → pokušaj zadatka → drugi db:init), i briše test bazu na kraju. Trebalo bi da ispiše **30 passed, 0 failed**.

---

## Baza podataka — shema

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

**Greška autentikacije**
```
Error: password authentication failed for user "..."
```
Provjeri `DB_USER` i `DB_PASSWORD` u `backend/.env`. Ako koristiš `DATABASE_URL`, provjeri format: `postgresql://USER:PASSWORD@HOST:PORT/DATABASE`.

**Port već zauzet**
```
Error: listen EADDRINUSE :::3001
```
Promijeni `PORT=3002` u `backend/.env` i ažuriraj `VITE_API_URL` u `frontend/.env` ako postoji.

**`.env` slučajno dodan u git**
`.env` je naveden u `.gitignore` i nikad ne smije biti commitovan. Ako jeste, ukloni ga iz git trackinga:
```bash
git rm --cached backend/.env
git commit -m "remove .env from tracking"
```
Rotira sve lozinke koje su bile u tom fajlu.

---

## Adding new datasets

See [docs/adding-new-dataset.md](docs/adding-new-dataset.md) for the full guide.

Quick summary: put source CSV files in `backend/src/data/datasets/<key>/raw/`, then run three commands from inside `backend/`:

```bash
npm run dataset:generate-config -- <datasetKey>
npm run dataset:build-sample -- <datasetKey>
npm run dataset:import -- <datasetKey>
```

The `csv/` folder is generated automatically — you do not create it manually. To undo and start over for one dataset: `npm run dataset:reset -- <datasetKey>`.

---

## Napomene za developere

- `.env` fajl se ne commituje — za konfiguraciju koristi `.env.example` kao predložak
- Stare razvojne skripte (`backend/db/legacy/01_create_tables.sql` itd.) su arhivirane i **ne koriste se** za normalni setup — koristi isključivo `npm run db:init`
- Detalji arhitekture, API endpointi, pravila za AI asistente: [`CLAUDE.md`](CLAUDE.md)

Backend skripte za verifikaciju:

```bash
cd backend
npm run test:setup-flow          # end-to-end setup flow (zahtijeva živu DB konekciju)
npm run test:sql-validator       # SQL structure validator
npm run test:compare-results     # result comparator
npm run test:sql-safety          # SQL safety validator
npm run test:order-detection     # ORDER BY detection
npm run test:required-order-by   # ORDER BY enforcement scope
npm run test:session-ownership   # session ownership (zahtijeva živu DB konekciju)
npm run test:query-limits        # row limit + timeout (zahtijeva živu DB konekciju)
```
