-- ============================================================
-- 05_populate_departments.sql
-- Popunjava departments i UPDATE-uje FK kolone
-- Idempotentna skripta (može se pokrenuti više puta)
-- ============================================================


-- ============================================================
-- KORAK 1: INSERT novih departmana po fakultetima
-- WHERE NOT EXISTS → ne duplikuje ako se skripta pokrene ponovo
-- ============================================================

-- FON — faculty_id = 1
INSERT INTO departments (name, faculty_id)
SELECT 'Informacioni sistemi i tehnologije', 1
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'Informacioni sistemi i tehnologije');

INSERT INTO departments (name, faculty_id)
SELECT 'Menadžment i organizacija', 1
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'Menadžment i organizacija');

INSERT INTO departments (name, faculty_id)
SELECT 'Operacioni menadžment', 1
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'Operacioni menadžment');

-- ETF — faculty_id = 2
INSERT INTO departments (name, faculty_id)
SELECT 'Softversko inženjerstvo i računarska tehnika', 2
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'Softversko inženjerstvo i računarska tehnika');

INSERT INTO departments (name, faculty_id)
SELECT 'Telekomunikacije i obrada informacija', 2
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'Telekomunikacije i obrada informacija');

INSERT INTO departments (name, faculty_id)
SELECT 'Elektronika', 2
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'Elektronika');

-- PMF NS — faculty_id = 3
INSERT INTO departments (name, faculty_id)
SELECT 'Matematika', 3
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'Matematika');

INSERT INTO departments (name, faculty_id)
SELECT 'Informatika', 3
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'Informatika');

INSERT INTO departments (name, faculty_id)
SELECT 'Fizika', 3
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'Fizika');

-- EKF Niš — faculty_id = 4
INSERT INTO departments (name, faculty_id)
SELECT 'Finansije i računovodstvo', 4
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'Finansije i računovodstvo');

INSERT INTO departments (name, faculty_id)
SELECT 'Marketing i menadžment', 4
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'Marketing i menadžment');

INSERT INTO departments (name, faculty_id)
SELECT 'Opšta ekonomija', 4
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'Opšta ekonomija');

-- MAT Beograd — faculty_id = 5
INSERT INTO departments (name, faculty_id)
SELECT 'Čista matematika', 5
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'Čista matematika');

INSERT INTO departments (name, faculty_id)
SELECT 'Primenjena matematika', 5
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'Primenjena matematika');

-- FTN NS — faculty_id = 6
INSERT INTO departments (name, faculty_id)
SELECT 'Mašinstvo i procesna tehnika', 6
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'Mašinstvo i procesna tehnika');

INSERT INTO departments (name, faculty_id)
SELECT 'Industrijsko inženjerstvo', 6
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'Industrijsko inženjerstvo');

INSERT INTO departments (name, faculty_id)
SELECT 'Mehatronika i robotika', 6
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'Mehatronika i robotika');

-- (opciono) Obriši stare company departmane koji nisu vezani za nijedan fakultet
-- DELETE FROM departments WHERE faculty_id IS NULL;


-- ============================================================
-- KORAK 2: UPDATE professors.department_id
-- ============================================================
UPDATE professors SET department_id = (
    SELECT id FROM departments WHERE name = 'Informacioni sistemi i tehnologije'
) WHERE id IN (1, 7); -- Petrović, Popović (FON)

UPDATE professors SET department_id = (
    SELECT id FROM departments WHERE name = 'Softversko inženjerstvo i računarska tehnika'
) WHERE id = 2; -- Nikolić (ETF)

UPDATE professors SET department_id = (
    SELECT id FROM departments WHERE name = 'Telekomunikacije i obrada informacija'
) WHERE id = 8; -- Đukić (ETF)

UPDATE professors SET department_id = (
    SELECT id FROM departments WHERE name = 'Matematika'
) WHERE id IN (3, 9); -- Jovanović, Lazić (PMF)

UPDATE professors SET department_id = (
    SELECT id FROM departments WHERE name = 'Finansije i računovodstvo'
) WHERE id = 4; -- Milošević (EKF)

UPDATE professors SET department_id = (
    SELECT id FROM departments WHERE name = 'Marketing i menadžment'
) WHERE id = 10; -- Vasić (EKF)

UPDATE professors SET department_id = (
    SELECT id FROM departments WHERE name = 'Primenjena matematika'
) WHERE id = 5; -- Đorđević (MAT)

UPDATE professors SET department_id = (
    SELECT id FROM departments WHERE name = 'Mašinstvo i procesna tehnika'
) WHERE id = 6; -- Stojanović (FTN)


-- ============================================================
-- KORAK 3: UPDATE subjects.department_id
-- ============================================================

-- FON predmeti (id 1–8) → Informacioni sistemi i tehnologije
UPDATE subjects SET department_id = (
    SELECT id FROM departments WHERE name = 'Informacioni sistemi i tehnologije'
) WHERE id BETWEEN 1 AND 8;

-- ETF predmeti
UPDATE subjects SET department_id = (
    SELECT id FROM departments WHERE name = 'Elektronika'
) WHERE id IN (10, 11, 12); -- Fizika 1, Električna kola, Digitalna elektronika

UPDATE subjects SET department_id = (
    SELECT id FROM departments WHERE name = 'Telekomunikacije i obrada informacija'
) WHERE id IN (13, 15, 16); -- Signali i sistemi, Telekomunikacije, Obrada signala

UPDATE subjects SET department_id = (
    SELECT id FROM departments WHERE name = 'Softversko inženjerstvo i računarska tehnika'
) WHERE id IN (9, 14); -- Matematika 1, Mikroprocesorski sistemi

-- PMF predmeti
UPDATE subjects SET department_id = (
    SELECT id FROM departments WHERE name = 'Matematika'
) WHERE id IN (17, 18, 19, 20, 21, 22); -- Analiza 1/2, Linearna algebra, Verovatnoća, Num. analiza, Topologija

UPDATE subjects SET department_id = (
    SELECT id FROM departments WHERE name = 'Informatika'
) WHERE id IN (23, 24); -- Diskretna matematika, Kombinatorika i grafovi

-- EKF predmeti
UPDATE subjects SET department_id = (
    SELECT id FROM departments WHERE name = 'Opšta ekonomija'
) WHERE id IN (25, 26, 30); -- Mikroekonomija, Makroekonomija, Statistika

UPDATE subjects SET department_id = (
    SELECT id FROM departments WHERE name = 'Finansije i računovodstvo'
) WHERE id IN (27, 28, 32); -- Računovodstvo, Finansijsko upravljanje, Poslovne finansije

UPDATE subjects SET department_id = (
    SELECT id FROM departments WHERE name = 'Marketing i menadžment'
) WHERE id IN (29, 31); -- Marketing, Menadžment

-- MAT predmeti
UPDATE subjects SET department_id = (
    SELECT id FROM departments WHERE name = 'Primenjena matematika'
) WHERE id IN (33, 34, 35, 37, 39, 40); -- Matematička analiza, Algebra, Analitička geometrija, Funkcionalna analiza, Kompleksna, PDE

UPDATE subjects SET department_id = (
    SELECT id FROM departments WHERE name = 'Čista matematika'
) WHERE id IN (36, 38); -- Teorija skupova, Teorija grafova

-- FTN predmeti
UPDATE subjects SET department_id = (
    SELECT id FROM departments WHERE name = 'Mašinstvo i procesna tehnika'
) WHERE id IN (41, 42, 43, 44); -- Mehanika, Termodinamika, Otpornost mat., Mašinski elementi

UPDATE subjects SET department_id = (
    SELECT id FROM departments WHERE name = 'Mehatronika i robotika'
) WHERE id IN (45, 46); -- Robotika, Automatika

UPDATE subjects SET department_id = (
    SELECT id FROM departments WHERE name = 'Industrijsko inženjerstvo'
) WHERE id IN (47, 48); -- Hidraulika, Računarska grafika


-- ============================================================
-- KORAK 4: UPDATE students.department_id
-- ============================================================

-- FON studenti (id 1–15)
UPDATE students SET department_id = (
    SELECT id FROM departments WHERE name = 'Informacioni sistemi i tehnologije'
) WHERE faculty_id = 1 AND id BETWEEN 1 AND 10;

UPDATE students SET department_id = (
    SELECT id FROM departments WHERE name = 'Menadžment i organizacija'
) WHERE faculty_id = 1 AND id BETWEEN 11 AND 15;

-- ETF studenti (id 16–30)
UPDATE students SET department_id = (
    SELECT id FROM departments WHERE name = 'Softversko inženjerstvo i računarska tehnika'
) WHERE faculty_id = 2 AND id BETWEEN 16 AND 23;

UPDATE students SET department_id = (
    SELECT id FROM departments WHERE name = 'Telekomunikacije i obrada informacija'
) WHERE faculty_id = 2 AND id BETWEEN 24 AND 30;

-- PMF studenti (id 31–45)
UPDATE students SET department_id = (
    SELECT id FROM departments WHERE name = 'Matematika'
) WHERE faculty_id = 3 AND id BETWEEN 31 AND 38;

UPDATE students SET department_id = (
    SELECT id FROM departments WHERE name = 'Informatika'
) WHERE faculty_id = 3 AND id BETWEEN 39 AND 45;

-- EKF studenti (id 46–60)
UPDATE students SET department_id = (
    SELECT id FROM departments WHERE name = 'Finansije i računovodstvo'
) WHERE faculty_id = 4 AND id BETWEEN 46 AND 53;

UPDATE students SET department_id = (
    SELECT id FROM departments WHERE name = 'Marketing i menadžment'
) WHERE faculty_id = 4 AND id BETWEEN 54 AND 60;

-- MAT studenti (id 61–75)
UPDATE students SET department_id = (
    SELECT id FROM departments WHERE name = 'Primenjena matematika'
) WHERE faculty_id = 5 AND id BETWEEN 61 AND 70;

UPDATE students SET department_id = (
    SELECT id FROM departments WHERE name = 'Čista matematika'
) WHERE faculty_id = 5 AND id BETWEEN 71 AND 75;

-- FTN studenti (id 76–90)
UPDATE students SET department_id = (
    SELECT id FROM departments WHERE name = 'Mašinstvo i procesna tehnika'
) WHERE faculty_id = 6 AND id BETWEEN 76 AND 83;

UPDATE students SET department_id = (
    SELECT id FROM departments WHERE name = 'Mehatronika i robotika'
) WHERE faculty_id = 6 AND id BETWEEN 84 AND 90;


-- ============================================================
-- KORAK 5: Verifikacija
-- ============================================================

-- V1: Fakulteti i njihovi departmani
SELECT
    f.name        AS fakultet,
    f.city,
    d.name        AS departman
FROM departments d
JOIN faculties f ON d.faculty_id = f.id
ORDER BY f.name, d.name;

-- V2: Profesori sa departmanom i fakultetom
SELECT
    p.title,
    p.first_name || ' ' || p.last_name  AS profesor,
    d.name    AS departman,
    f.name    AS fakultet
FROM professors p
LEFT JOIN departments d ON p.department_id = d.id
LEFT JOIN faculties f   ON d.faculty_id    = f.id
ORDER BY f.name, d.name, p.last_name;

-- V3: Predmeti sa departmanom i fakultetom (oba FK za poređenje)
SELECT
    sub.name                AS predmet,
    sub.semester,
    sub.ects,
    d.name                  AS departman,
    f_dep.name              AS fakultet_via_dept,
    f_dir.name              AS fakultet_direktno
FROM subjects sub
LEFT JOIN departments d  ON sub.department_id = d.id
LEFT JOIN faculties f_dep ON d.faculty_id     = f_dep.id
LEFT JOIN faculties f_dir ON sub.faculty_id   = f_dir.id
ORDER BY f_dir.name, sub.semester;

-- V4: Studenti sa departmanom i fakultetom
SELECT
    s.first_name || ' ' || s.last_name  AS student,
    s.index_number,
    d.name    AS departman,
    f.name    AS fakultet
FROM students s
LEFT JOIN departments d ON s.department_id = d.id
LEFT JOIN faculties f   ON s.faculty_id    = f.id
ORDER BY f.name, d.name, s.last_name;

-- V5: Ispiti sa studentom, predmetom, profesorom, departmanom i fakultetom
SELECT
    s.first_name || ' ' || s.last_name   AS student,
    sub.name                              AS predmet,
    p.last_name                           AS profesor,
    d_s.name                              AS departman_studenta,
    f.name                                AS fakultet,
    e.grade,
    e.passed
FROM exams e
JOIN students s    ON e.student_id   = s.id
JOIN subjects sub  ON e.subject_id   = sub.id
JOIN professors p  ON e.professor_id = p.id
JOIN faculties f   ON sub.faculty_id = f.id
LEFT JOIN departments d_s ON s.department_id = d_s.id
ORDER BY f.name, s.last_name;
