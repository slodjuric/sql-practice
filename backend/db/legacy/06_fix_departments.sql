-- ============================================================
-- 06_fix_departments.sql
-- Popunjava NULL vrednosti u departments tabeli:
--   • faculty_id za stare (company) departmane
--   • location za sve departmane koji je nemaju
-- Na kraju dodaje NOT NULL constraints na obe kolone.
-- Idempotentna skripta — sigurno za višekratno pokretanje.
-- ============================================================


-- ============================================================
-- KORAK 0: Osiguraj da location kolona postoji
-- (ADD COLUMN IF NOT EXISTS ne radi ništa ako kolona već postoji)
-- ============================================================
ALTER TABLE departments
    ADD COLUMN IF NOT EXISTS location VARCHAR(100);


-- ============================================================
-- KORAK 1: Poveži stare company departmane sa fakultetima
--
-- Ovi departmani (IT, HR, Finance, Marketing, Operations) nastali
-- su iz originalnog HR/company modela i nemaju faculty_id.
-- Sada ih logički mapiramo na odgovarajući fakultet.
--
-- Svi UPDATE-i imaju WHERE faculty_id IS NULL da bi bili idempotentni.
-- ============================================================

-- IT → Elektrotehnički fakultet
-- Obrazloženje: IT department konceptualno pokriva oblasti
-- koje ETF nudi (računarstvo, telekomunikacije, elektronika).
-- Alternativa: FON — promeni ako preferuješ organizacioni pristup.
UPDATE departments
SET faculty_id = (
    SELECT id FROM faculties WHERE name = 'Elektrotehnički fakultet'
)
WHERE LOWER(name) = 'it'
  AND faculty_id IS NULL;

-- HR → Fakultet organizacionih nauka
UPDATE departments
SET faculty_id = (
    SELECT id FROM faculties WHERE name = 'Fakultet organizacionih nauka'
)
WHERE LOWER(name) = 'hr'
  AND faculty_id IS NULL;

-- Finance → Ekonomski fakultet
UPDATE departments
SET faculty_id = (
    SELECT id FROM faculties WHERE name = 'Ekonomski fakultet'
)
WHERE LOWER(name) = 'finance'
  AND faculty_id IS NULL;

-- Marketing → Ekonomski fakultet
UPDATE departments
SET faculty_id = (
    SELECT id FROM faculties WHERE name = 'Ekonomski fakultet'
)
WHERE LOWER(name) = 'marketing'
  AND faculty_id IS NULL;

-- Operations → Fakultet organizacionih nauka
UPDATE departments
SET faculty_id = (
    SELECT id FROM faculties WHERE name = 'Fakultet organizacionih nauka'
)
WHERE LOWER(name) = 'operations'
  AND faculty_id IS NULL;


-- ============================================================
-- PROVERA 1A: Departmani koji i dalje nemaju faculty_id
--
-- Ako ovaj SELECT vrati redove, potrebna je ručna akcija.
-- Opcije po redu:
--   a) Poveži ručno: UPDATE departments SET faculty_id = X WHERE id = Y;
--   b) Obriši: DELETE FROM departments WHERE id = Y;  (samo ako nema FK veza)
--   c) Preimenuj da odgovara postojećem modelu, pa poveži.
-- ============================================================
SELECT
    id,
    name,
    location,
    faculty_id,
    '!!! faculty_id je NULL — potrebna ručna akcija !!!' AS napomena
FROM departments
WHERE faculty_id IS NULL;


-- ============================================================
-- KORAK 2: Popuni location za sve departmane koji je nemaju
--
-- Uzima city direktno iz faculties tabele.
-- Radi za sve departmane (stare i nove) koji imaju faculty_id.
-- Departmani bez faculty_id preskočeni su automatski
-- (d.faculty_id = f.id neće matchovati NULL).
-- ============================================================
UPDATE departments d
SET location = f.city
FROM faculties f
WHERE d.faculty_id = f.id
  AND d.location IS NULL;


-- ============================================================
-- PROVERA 2A: Departmani koji i dalje nemaju location
--
-- Ako ovaj SELECT vrati redove, uzrok je faculty_id IS NULL
-- (nije rešeno u koraku 1). Reši taj red prvo.
-- ============================================================
SELECT
    d.id,
    d.name,
    d.faculty_id,
    d.location,
    '!!! location je NULL !!!' AS napomena
FROM departments d
WHERE d.location IS NULL;


-- ============================================================
-- PROVERA 2B: Potpuni pregled departments tabele
-- Prikazuje sve departmane sa fakultetom i gradom.
-- ============================================================
SELECT
    d.id,
    d.name          AS departman,
    d.location,
    f.name          AS fakultet,
    f.city          AS grad_fakulteta,
    CASE
        WHEN d.location = f.city THEN 'OK'
        ELSE '!!! location ne odgovara gradu fakulteta'
    END             AS provera
FROM departments d
LEFT JOIN faculties f ON d.faculty_id = f.id
ORDER BY f.name NULLS LAST, d.name;


-- ============================================================
-- KORAK 3: Dodaj NOT NULL constraints
--
-- DO blok proverava pre ALTER TABLE:
--   • Ako ima NULL vrednosti → RAISE EXCEPTION (skripta staje,
--     constraints se NE dodaju, podaci ostaju netaknuti).
--   • Ako nema NULL vrednosti → ALTER TABLE se izvršava.
--
-- Constraint je idempotentni: SET NOT NULL na koloni koja već
-- ima constraint rade bez greške u PostgreSQL-u.
-- ============================================================
DO $$
DECLARE
    null_faculty_count INT;
    null_location_count INT;
BEGIN
    SELECT COUNT(*) INTO null_faculty_count
    FROM departments WHERE faculty_id IS NULL;

    SELECT COUNT(*) INTO null_location_count
    FROM departments WHERE location IS NULL;

    IF null_faculty_count > 0 THEN
        RAISE EXCEPTION
            'Ne mogu dodati NOT NULL constraint: % departman(a) ima faculty_id IS NULL. Reši PROVERU 1A iznad.',
            null_faculty_count;
    END IF;

    IF null_location_count > 0 THEN
        RAISE EXCEPTION
            'Ne mogu dodati NOT NULL constraint: % departman(a) ima location IS NULL. Reši PROVERU 2A iznad.',
            null_location_count;
    END IF;

    EXECUTE 'ALTER TABLE departments ALTER COLUMN faculty_id SET NOT NULL';
    EXECUTE 'ALTER TABLE departments ALTER COLUMN location   SET NOT NULL';

    RAISE NOTICE '✓ NOT NULL constraints uspešno dodati na faculty_id i location.';
END $$;


-- ============================================================
-- FINALNA PROVERA: Potvrdi da constraints postoje u šemi
-- ============================================================
SELECT
    column_name,
    is_nullable,
    data_type,
    character_maximum_length
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'departments'
  AND column_name IN ('faculty_id', 'location')
ORDER BY column_name;
-- is_nullable = 'NO' znači da NOT NULL constraint postoji
