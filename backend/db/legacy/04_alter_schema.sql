-- ============================================================
-- 04_alter_schema.sql — Izmena šeme
-- ============================================================
-- Redosled izvršavanja je važan zbog FK veza.
-- Sve ADD COLUMN komande su IF NOT EXISTS — sigurno za višekratno pokretanje.
-- ============================================================


-- ============================================================
-- KORAK 1: Ukloni staru unazad-okrenotu vezu faculties → departments
-- (bila je NULL u svim redovima, logički neispravna)
-- ============================================================
ALTER TABLE faculties DROP COLUMN IF EXISTS department_id;

-- students.department_id već postoji iz originalne šeme
-- (students → departments, ispravna veza — ne dirajmo je)


-- ============================================================
-- KORAK 2: departments pripada jednom fakultetu
-- departments.faculty_id → faculties.id
-- ============================================================
ALTER TABLE departments
    ADD COLUMN IF NOT EXISTS faculty_id INTEGER;

-- Dodaj FK constraint (DROP prvo da bi skripta bila idempotentna)
ALTER TABLE departments
    DROP CONSTRAINT IF EXISTS departments_faculty_id_fkey;

ALTER TABLE departments
    ADD CONSTRAINT departments_faculty_id_fkey
    FOREIGN KEY (faculty_id) REFERENCES faculties(id);


-- ============================================================
-- KORAK 3: professors pripada departmanu
-- professors.department_id → departments.id
-- ============================================================
ALTER TABLE professors
    ADD COLUMN IF NOT EXISTS department_id INTEGER;

ALTER TABLE professors
    DROP CONSTRAINT IF EXISTS professors_department_id_fkey;

ALTER TABLE professors
    ADD CONSTRAINT professors_department_id_fkey
    FOREIGN KEY (department_id) REFERENCES departments(id);


-- ============================================================
-- KORAK 4: subjects može biti organizovan u okviru departmana
-- subjects.department_id → departments.id  (nullable — predmet može biti samo na nivou fakulteta)
-- ============================================================
ALTER TABLE subjects
    ADD COLUMN IF NOT EXISTS department_id INTEGER;

ALTER TABLE subjects
    DROP CONSTRAINT IF EXISTS subjects_department_id_fkey;

ALTER TABLE subjects
    ADD CONSTRAINT subjects_department_id_fkey
    FOREIGN KEY (department_id) REFERENCES departments(id);


-- ============================================================
-- KORAK 5: Provera zavisnosti prema employees tabeli
-- ============================================================

-- Ovaj upit prikazuje sve FK koji referenciraju employees — pokreni pre DROP-a:
-- SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table
-- FROM information_schema.table_constraints AS tc
-- JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name
-- JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name
-- WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'employees';


-- ============================================================
-- KORAK 6: Brisanje employees tabele
-- CASCADE briše i sve FK constraints koji referenciraju ovu tabelu
-- ============================================================
DROP TABLE IF EXISTS employees CASCADE;


-- ============================================================
-- PROVERA — finalna šema veza
-- ============================================================

-- Prikaži sve FK u bazi nakon izmena:
SELECT
    tc.table_name         AS "tabela",
    kcu.column_name       AS "kolona",
    ccu.table_name        AS "→ tabela",
    ccu.column_name       AS "→ kolona"
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
    ON tc.constraint_name = kcu.constraint_name
    AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage AS ccu
    ON ccu.constraint_name = tc.constraint_name
    AND ccu.table_schema = tc.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'public'
ORDER BY tc.table_name, kcu.column_name;
