-- ============================================================
-- academic.sql
--
-- Creates and populates the Academic practice dataset.
-- All tables live in the "academic" schema.
--
-- Tables: faculties, departments, professors, subjects,
--         students, exams, professor_subjects
--
-- Safe to run on an existing database — drops and recreates
-- the academic schema from scratch.
-- Does NOT touch progress tables:
--   users, learning_sessions, learning_session_filters,
--   task_attempts, user_task_progress
-- Those are managed by initDb.js on every server start.
-- ============================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS academic;

-- ── Drop in reverse dependency order ───────────────────────────────────────
DROP TABLE IF EXISTS academic.exams              CASCADE;
DROP TABLE IF EXISTS academic.professor_subjects CASCADE;
DROP TABLE IF EXISTS academic.students           CASCADE;
DROP TABLE IF EXISTS academic.professors         CASCADE;
DROP TABLE IF EXISTS academic.subjects           CASCADE;
DROP TABLE IF EXISTS academic.departments        CASCADE;
DROP TABLE IF EXISTS academic.faculties          CASCADE;


-- ── faculties ───────────────────────────────────────────────────────────────
CREATE TABLE academic.faculties (
    id               SERIAL PRIMARY KEY,
    name             VARCHAR(150) NOT NULL,
    city             VARCHAR(100) NOT NULL,
    university_name  VARCHAR(150) NOT NULL
);

-- ── departments ─────────────────────────────────────────────────────────────
CREATE TABLE academic.departments (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    location    VARCHAR(100) NOT NULL,
    faculty_id  INTEGER      NOT NULL REFERENCES academic.faculties(id)
);

-- ── professors ──────────────────────────────────────────────────────────────
CREATE TABLE academic.professors (
    id             SERIAL PRIMARY KEY,
    first_name     VARCHAR(100) NOT NULL,
    last_name      VARCHAR(100) NOT NULL,
    title          VARCHAR(50),
    email          VARCHAR(150) UNIQUE NOT NULL,
    department_id  INTEGER REFERENCES academic.departments(id)
);

-- ── subjects ────────────────────────────────────────────────────────────────
CREATE TABLE academic.subjects (
    id             SERIAL PRIMARY KEY,
    name           VARCHAR(150) NOT NULL,
    semester       SMALLINT     NOT NULL CHECK (semester BETWEEN 1 AND 12),
    ects           SMALLINT     NOT NULL CHECK (ects    BETWEEN 1 AND 30),
    faculty_id     INTEGER      NOT NULL REFERENCES academic.faculties(id),
    department_id  INTEGER               REFERENCES academic.departments(id)
);

-- ── students ────────────────────────────────────────────────────────────────
CREATE TABLE academic.students (
    id               SERIAL PRIMARY KEY,
    first_name       VARCHAR(100) NOT NULL,
    last_name        VARCHAR(100) NOT NULL,
    index_number     VARCHAR(20)  UNIQUE NOT NULL,
    enrollment_year  SMALLINT     NOT NULL,
    faculty_id       INTEGER      NOT NULL REFERENCES academic.faculties(id),
    department_id    INTEGER               REFERENCES academic.departments(id)
);

-- ── exams ───────────────────────────────────────────────────────────────────
CREATE TABLE academic.exams (
    id            SERIAL PRIMARY KEY,
    student_id    INTEGER  NOT NULL REFERENCES academic.students(id),
    subject_id    INTEGER  NOT NULL REFERENCES academic.subjects(id),
    professor_id  INTEGER  NOT NULL REFERENCES academic.professors(id),
    exam_date     DATE     NOT NULL,
    grade         SMALLINT NOT NULL CHECK (grade BETWEEN 5 AND 10),
    passed        BOOLEAN  NOT NULL GENERATED ALWAYS AS (grade > 5) STORED
);

-- ── professor_subjects ───────────────────────────────────────────────────────
CREATE TABLE academic.professor_subjects (
    id            SERIAL PRIMARY KEY,
    professor_id  INTEGER NOT NULL REFERENCES academic.professors(id),
    subject_id    INTEGER NOT NULL REFERENCES academic.subjects(id),
    UNIQUE (professor_id, subject_id)
);


-- ============================================================
-- DATA
-- ============================================================

-- ── faculties (6 rows, ids 1–6) ─────────────────────────────────────────────
INSERT INTO academic.faculties (name, city, university_name) VALUES
('Fakultet organizacionih nauka', 'Beograd',  'Univerzitet u Beogradu'),
('Elektrotehnički fakultet',       'Beograd',  'Univerzitet u Beogradu'),
('Prirodno-matematički fakultet',  'Novi Sad', 'Univerzitet u Novom Sadu'),
('Ekonomski fakultet',             'Niš',      'Univerzitet u Nišu'),
('Matematički fakultet',           'Beograd',  'Univerzitet u Beogradu'),
('Fakultet tehničkih nauka',       'Novi Sad', 'Univerzitet u Novom Sadu');


-- ── departments (17 rows) ───────────────────────────────────────────────────
-- FON — faculty_id = 1
INSERT INTO academic.departments (name, location, faculty_id) VALUES
('Informacioni sistemi i tehnologije',           'Beograd',  1),
('Menadžment i organizacija',                    'Beograd',  1),
('Operacioni menadžment',                        'Beograd',  1),
-- ETF — faculty_id = 2
('Softversko inženjerstvo i računarska tehnika', 'Beograd',  2),
('Telekomunikacije i obrada informacija',        'Beograd',  2),
('Elektronika',                                  'Beograd',  2),
-- PMF NS — faculty_id = 3
('Matematika',                                   'Novi Sad', 3),
('Informatika',                                  'Novi Sad', 3),
('Fizika',                                       'Novi Sad', 3),
-- EKF Niš — faculty_id = 4
('Finansije i računovodstvo',                    'Niš',      4),
('Marketing i menadžment',                       'Niš',      4),
('Opšta ekonomija',                              'Niš',      4),
-- MAT Beograd — faculty_id = 5
('Čista matematika',                             'Beograd',  5),
('Primenjena matematika',                        'Beograd',  5),
-- FTN NS — faculty_id = 6
('Mašinstvo i procesna tehnika',                 'Novi Sad', 6),
('Industrijsko inženjerstvo',                    'Novi Sad', 6),
('Mehatronika i robotika',                       'Novi Sad', 6);


-- ── professors (10 rows, ids 1–10) ──────────────────────────────────────────
INSERT INTO academic.professors (first_name, last_name, title, email) VALUES
('Marko',      'Petrović',   'vanredni profesor', 'marko.petrovic@fon.bg.ac.rs'),
('Jelena',     'Nikolić',    'redovni profesor',  'jelena.nikolic@etf.bg.ac.rs'),
('Stefan',     'Jovanović',  'docent',            'stefan.jovanovic@pmf.uns.ac.rs'),
('Ana',        'Milošević',  'vanredni profesor', 'ana.milosevic@ekfak.ni.ac.rs'),
('Petar',      'Đorđević',   'redovni profesor',  'petar.djordjevic@matf.bg.ac.rs'),
('Milica',     'Stojanović', 'docent',            'milica.stojanovic@ftn.uns.ac.rs'),
('Nikola',     'Popović',    'docent',            'nikola.popovic@fon.bg.ac.rs'),
('Ivana',      'Đukić',      'docent',            'ivana.djukic@etf.bg.ac.rs'),
('Aleksandar', 'Lazić',      'vanredni profesor', 'aleksandar.lazic@pmf.uns.ac.rs'),
('Maja',       'Vasić',      'redovni profesor',  'maja.vasic@ekfak.ni.ac.rs');

-- Set professor → department assignments
UPDATE academic.professors SET department_id = (SELECT id FROM academic.departments WHERE name = 'Informacioni sistemi i tehnologije')           WHERE id IN (1, 7);
UPDATE academic.professors SET department_id = (SELECT id FROM academic.departments WHERE name = 'Softversko inženjerstvo i računarska tehnika') WHERE id = 2;
UPDATE academic.professors SET department_id = (SELECT id FROM academic.departments WHERE name = 'Telekomunikacije i obrada informacija')        WHERE id = 8;
UPDATE academic.professors SET department_id = (SELECT id FROM academic.departments WHERE name = 'Matematika')                                   WHERE id IN (3, 9);
UPDATE academic.professors SET department_id = (SELECT id FROM academic.departments WHERE name = 'Finansije i računovodstvo')                    WHERE id = 4;
UPDATE academic.professors SET department_id = (SELECT id FROM academic.departments WHERE name = 'Marketing i menadžment')                       WHERE id = 10;
UPDATE academic.professors SET department_id = (SELECT id FROM academic.departments WHERE name = 'Primenjena matematika')                        WHERE id = 5;
UPDATE academic.professors SET department_id = (SELECT id FROM academic.departments WHERE name = 'Mašinstvo i procesna tehnika')                 WHERE id = 6;


-- ── subjects (48 rows, ids 1–48) ────────────────────────────────────────────
INSERT INTO academic.subjects (name, semester, ects, faculty_id) VALUES
-- FON (faculty_id = 1) → ids 1–8
('Osnovi programiranja',              1, 7, 1),
('Baze podataka',                     3, 6, 1),
('Algoritmi i strukture podataka',    2, 6, 1),
('Web programiranje',                 4, 5, 1),
('Operativni sistemi',                3, 5, 1),
('Softversko inženjerstvo',           5, 6, 1),
('Mreže računara',                    4, 5, 1),
('Veštačka inteligencija',            6, 6, 1),
-- ETF (faculty_id = 2) → ids 9–16
('Matematika 1',                      1, 8, 2),
('Fizika 1',                          1, 7, 2),
('Električna kola 1',                 2, 6, 2),
('Digitalna elektronika',             3, 6, 2),
('Signali i sistemi',                 4, 6, 2),
('Mikroprocesorski sistemi',          5, 5, 2),
('Telekomunikacije',                  5, 6, 2),
('Obrada signala',                    6, 6, 2),
-- PMF NS (faculty_id = 3) → ids 17–24
('Analiza 1',                         1, 8, 3),
('Linearna algebra',                  1, 6, 3),
('Analiza 2',                         2, 8, 3),
('Verovatnoća i statistika',          3, 6, 3),
('Numerička analiza',                 4, 6, 3),
('Topologija',                        5, 6, 3),
('Diskretna matematika',              2, 5, 3),
('Kombinatorika i grafovi',           4, 5, 3),
-- EKF Niš (faculty_id = 4) → ids 25–32
('Mikroekonomija',                    1, 6, 4),
('Makroekonomija',                    2, 6, 4),
('Računovodstvo 1',                   2, 6, 4),
('Finansijsko upravljanje',           4, 6, 4),
('Marketing',                         3, 5, 4),
('Statistika u ekonomiji',            3, 6, 4),
('Menadžment',                        4, 5, 4),
('Poslovne finansije',                5, 6, 4),
-- MAT Beograd (faculty_id = 5) → ids 33–40
('Matematička analiza 1',             1, 8, 5),
('Algebra 1',                         1, 7, 5),
('Analitička geometrija',             1, 6, 5),
('Teorija skupova',                   2, 5, 5),
('Funkcionalna analiza',              5, 7, 5),
('Teorija grafova',                   4, 6, 5),
('Kompleksna analiza',                4, 6, 5),
('Parcijalne diferencijalne jednačine', 6, 6, 5),
-- FTN NS (faculty_id = 6) → ids 41–48
('Mehanika 1',                        1, 7, 6),
('Termodinamika',                     2, 6, 6),
('Otpornost materijala',              3, 6, 6),
('Mašinski elementi',                 3, 6, 6),
('Robotika',                          5, 6, 6),
('Automatika',                        4, 6, 6),
('Hidraulika i pneumatika',           4, 5, 6),
('Računarska grafika',                6, 5, 6);

-- Set subject → department assignments
UPDATE academic.subjects SET department_id = (SELECT id FROM academic.departments WHERE name = 'Informacioni sistemi i tehnologije')           WHERE id BETWEEN 1  AND 8;
UPDATE academic.subjects SET department_id = (SELECT id FROM academic.departments WHERE name = 'Softversko inženjerstvo i računarska tehnika') WHERE id IN (9, 14);
UPDATE academic.subjects SET department_id = (SELECT id FROM academic.departments WHERE name = 'Elektronika')                                  WHERE id IN (10, 11, 12);
UPDATE academic.subjects SET department_id = (SELECT id FROM academic.departments WHERE name = 'Telekomunikacije i obrada informacija')        WHERE id IN (13, 15, 16);
UPDATE academic.subjects SET department_id = (SELECT id FROM academic.departments WHERE name = 'Matematika')                                   WHERE id IN (17, 18, 19, 20, 21, 22);
UPDATE academic.subjects SET department_id = (SELECT id FROM academic.departments WHERE name = 'Informatika')                                  WHERE id IN (23, 24);
UPDATE academic.subjects SET department_id = (SELECT id FROM academic.departments WHERE name = 'Opšta ekonomija')                              WHERE id IN (25, 26, 30);
UPDATE academic.subjects SET department_id = (SELECT id FROM academic.departments WHERE name = 'Finansije i računovodstvo')                    WHERE id IN (27, 28, 32);
UPDATE academic.subjects SET department_id = (SELECT id FROM academic.departments WHERE name = 'Marketing i menadžment')                      WHERE id IN (29, 31);
UPDATE academic.subjects SET department_id = (SELECT id FROM academic.departments WHERE name = 'Primenjena matematika')                        WHERE id IN (33, 34, 35, 37, 39, 40);
UPDATE academic.subjects SET department_id = (SELECT id FROM academic.departments WHERE name = 'Čista matematika')                            WHERE id IN (36, 38);
UPDATE academic.subjects SET department_id = (SELECT id FROM academic.departments WHERE name = 'Mašinstvo i procesna tehnika')                 WHERE id IN (41, 42, 43, 44);
UPDATE academic.subjects SET department_id = (SELECT id FROM academic.departments WHERE name = 'Mehatronika i robotika')                      WHERE id IN (45, 46);
UPDATE academic.subjects SET department_id = (SELECT id FROM academic.departments WHERE name = 'Industrijsko inženjerstvo')                    WHERE id IN (47, 48);


-- ── students (90 rows, ids 1–90) ────────────────────────────────────────────
-- FON (faculty_id = 1, ids 1–15)
INSERT INTO academic.students (first_name, last_name, index_number, enrollment_year, faculty_id) VALUES
('Marko',    'Petrović',   'FON-22-001', 2022, 1),
('Ana',      'Nikolić',    'FON-22-002', 2022, 1),
('Stefan',   'Jovanović',  'FON-21-003', 2021, 1),
('Jelena',   'Milošević',  'FON-22-004', 2022, 1),
('Nikola',   'Đorđević',   'FON-23-005', 2023, 1),
('Milica',   'Stojanović', 'FON-22-006', 2022, 1),
('Aleksa',   'Popović',    'FON-21-007', 2021, 1),
('Ivana',    'Đukić',      'FON-22-008', 2022, 1),
('Petar',    'Lazić',      'FON-23-009', 2023, 1),
('Maja',     'Vasić',      'FON-22-010', 2022, 1),
('Milan',    'Marković',   'FON-21-011', 2021, 1),
('Tamara',   'Pavlović',   'FON-22-012', 2022, 1),
('Jovan',    'Simić',      'FON-23-013', 2023, 1),
('Marina',   'Ristić',     'FON-22-014', 2022, 1),
('Filip',    'Stanković',  'FON-21-015', 2021, 1);

-- ETF (faculty_id = 2, ids 16–30)
INSERT INTO academic.students (first_name, last_name, index_number, enrollment_year, faculty_id) VALUES
('Lazar',    'Đurić',      'ETF-22-001', 2022, 2),
('Katarina', 'Ilić',       'ETF-22-002', 2022, 2),
('Nemanja',  'Tešić',      'ETF-21-003', 2021, 2),
('Bojana',   'Nešić',      'ETF-22-004', 2022, 2),
('Vuk',      'Matić',      'ETF-23-005', 2023, 2),
('Dragana',  'Đorić',      'ETF-22-006', 2022, 2),
('Bogdan',   'Nikolić',    'ETF-21-007', 2021, 2),
('Sandra',   'Petrović',   'ETF-22-008', 2022, 2),
('Uroš',     'Jovanović',  'ETF-23-009', 2023, 2),
('Nevena',   'Milić',      'ETF-22-010', 2022, 2),
('Mihajlo',  'Stefanović', 'ETF-21-011', 2021, 2),
('Tijana',   'Filipović',  'ETF-22-012', 2022, 2),
('Bojan',    'Đukić',      'ETF-23-013', 2023, 2),
('Vesna',    'Lazović',    'ETF-22-014', 2022, 2),
('Đorđe',    'Ristić',     'ETF-21-015', 2021, 2);

-- PMF NS (faculty_id = 3, ids 31–45)
INSERT INTO academic.students (first_name, last_name, index_number, enrollment_year, faculty_id) VALUES
('Sara',       'Kovačević',  'PMF-22-001', 2022, 3),
('Dragan',     'Tomić',      'PMF-22-002', 2022, 3),
('Emilija',    'Stanić',     'PMF-21-003', 2021, 3),
('Aleksandar', 'Lukić',      'PMF-22-004', 2022, 3),
('Jelena',     'Pejović',    'PMF-23-005', 2023, 3),
('Marija',     'Radović',    'PMF-22-006', 2022, 3),
('Nikola',     'Kostić',     'PMF-21-007', 2021, 3),
('Nataša',     'Vuković',    'PMF-22-008', 2022, 3),
('Danilo',     'Čukić',      'PMF-23-009', 2023, 3),
('Milena',     'Aleksić',    'PMF-22-010', 2022, 3),
('Slobodan',   'Ninković',   'PMF-21-011', 2021, 3),
('Jovana',     'Ilić',       'PMF-22-012', 2022, 3),
('Rade',       'Đorđević',   'PMF-23-013', 2023, 3),
('Teodora',    'Miletić',    'PMF-22-014', 2022, 3),
('Nemanja',    'Bogdanović', 'PMF-21-015', 2021, 3);

-- EKF Niš (faculty_id = 4, ids 46–60)
INSERT INTO academic.students (first_name, last_name, index_number, enrollment_year, faculty_id) VALUES
('Kristina',   'Stevanović', 'EKF-22-001', 2022, 4),
('Branko',     'Todorović',  'EKF-22-002', 2022, 4),
('Tatjana',    'Marinković', 'EKF-21-003', 2021, 4),
('Miloš',      'Đorđić',     'EKF-22-004', 2022, 4),
('Aleksandra', 'Milović',    'EKF-23-005', 2023, 4),
('Srđan',      'Stević',     'EKF-22-006', 2022, 4),
('Biljana',    'Đurić',      'EKF-21-007', 2021, 4),
('Dušan',      'Tomić',      'EKF-22-008', 2022, 4),
('Sonja',      'Radulović',  'EKF-23-009', 2023, 4),
('Nemanja',    'Jović',      'EKF-22-010', 2022, 4),
('Olivera',    'Stanković',  'EKF-21-011', 2021, 4),
('Miroslav',   'Savić',      'EKF-22-012', 2022, 4),
('Dragana',    'Milošević',  'EKF-23-013', 2023, 4),
('Nenad',      'Petrović',   'EKF-22-014', 2022, 4),
('Ivona',      'Nikolić',    'EKF-21-015', 2021, 4);

-- MAT Beograd (faculty_id = 5, ids 61–75)
INSERT INTO academic.students (first_name, last_name, index_number, enrollment_year, faculty_id) VALUES
('Miljan',   'Živković',      'MAT-22-001', 2022, 5),
('Zorana',   'Đorđević',      'MAT-22-002', 2022, 5),
('Nikola',   'Filipović',     'MAT-21-003', 2021, 5),
('Ana',      'Stanković',     'MAT-22-004', 2022, 5),
('Jovan',    'Milosavljević', 'MAT-23-005', 2023, 5),
('Vesna',    'Ilić',          'MAT-22-006', 2022, 5),
('Stevan',   'Vujović',       'MAT-21-007', 2021, 5),
('Maja',     'Milošević',     'MAT-22-008', 2022, 5),
('Andrija',  'Stanić',        'MAT-23-009', 2023, 5),
('Bojana',   'Janković',      'MAT-22-010', 2022, 5),
('Predrag',  'Tomić',         'MAT-21-011', 2021, 5),
('Snežana',  'Bošković',      'MAT-22-012', 2022, 5),
('Goran',    'Đukić',         'MAT-23-013', 2023, 5),
('Anđela',   'Petrović',      'MAT-22-014', 2022, 5),
('Ognjen',   'Ristić',        'MAT-21-015', 2021, 5);

-- FTN NS (faculty_id = 6, ids 76–90)
INSERT INTO academic.students (first_name, last_name, index_number, enrollment_year, faculty_id) VALUES
('Vladimir', 'Tošić',       'FTN-22-001', 2022, 6),
('Sanja',    'Đorić',       'FTN-22-002', 2022, 6),
('Rade',     'Savić',       'FTN-21-003', 2021, 6),
('Jelena',   'Marinović',   'FTN-22-004', 2022, 6),
('Mihajlo',  'Petrović',    'FTN-23-005', 2023, 6),
('Tamara',   'Ristić',      'FTN-22-006', 2022, 6),
('Dragan',   'Ilić',        'FTN-21-007', 2021, 6),
('Milena',   'Đurić',       'FTN-22-008', 2022, 6),
('Bojan',    'Nikolić',     'FTN-23-009', 2023, 6),
('Ivana',    'Jović',       'FTN-22-010', 2022, 6),
('Stanislav','Kovač',       'FTN-21-011', 2021, 6),
('Nina',     'Stefanović',  'FTN-22-012', 2022, 6),
('Dušan',    'Vasić',       'FTN-23-013', 2023, 6),
('Iva',      'Đorđević',    'FTN-22-014', 2022, 6),
('Marko',    'Radović',     'FTN-21-015', 2021, 6);

-- Set student → department assignments
UPDATE academic.students SET department_id = (SELECT id FROM academic.departments WHERE name = 'Informacioni sistemi i tehnologije') WHERE faculty_id = 1 AND id BETWEEN 1  AND 10;
UPDATE academic.students SET department_id = (SELECT id FROM academic.departments WHERE name = 'Menadžment i organizacija')          WHERE faculty_id = 1 AND id BETWEEN 11 AND 15;
UPDATE academic.students SET department_id = (SELECT id FROM academic.departments WHERE name = 'Softversko inženjerstvo i računarska tehnika') WHERE faculty_id = 2 AND id BETWEEN 16 AND 23;
UPDATE academic.students SET department_id = (SELECT id FROM academic.departments WHERE name = 'Telekomunikacije i obrada informacija')        WHERE faculty_id = 2 AND id BETWEEN 24 AND 30;
UPDATE academic.students SET department_id = (SELECT id FROM academic.departments WHERE name = 'Matematika')  WHERE faculty_id = 3 AND id BETWEEN 31 AND 38;
UPDATE academic.students SET department_id = (SELECT id FROM academic.departments WHERE name = 'Informatika') WHERE faculty_id = 3 AND id BETWEEN 39 AND 45;
UPDATE academic.students SET department_id = (SELECT id FROM academic.departments WHERE name = 'Finansije i računovodstvo') WHERE faculty_id = 4 AND id BETWEEN 46 AND 53;
UPDATE academic.students SET department_id = (SELECT id FROM academic.departments WHERE name = 'Marketing i menadžment')    WHERE faculty_id = 4 AND id BETWEEN 54 AND 60;
UPDATE academic.students SET department_id = (SELECT id FROM academic.departments WHERE name = 'Primenjena matematika') WHERE faculty_id = 5 AND id BETWEEN 61 AND 70;
UPDATE academic.students SET department_id = (SELECT id FROM academic.departments WHERE name = 'Čista matematika')     WHERE faculty_id = 5 AND id BETWEEN 71 AND 75;
UPDATE academic.students SET department_id = (SELECT id FROM academic.departments WHERE name = 'Mašinstvo i procesna tehnika') WHERE faculty_id = 6 AND id BETWEEN 76 AND 83;
UPDATE academic.students SET department_id = (SELECT id FROM academic.departments WHERE name = 'Mehatronika i robotika')       WHERE faculty_id = 6 AND id BETWEEN 84 AND 90;


-- ── professor_subjects ──────────────────────────────────────────────────────
INSERT INTO academic.professor_subjects (professor_id, subject_id) VALUES
-- Prof 1 Petrović — FON predmeti 1–4
(1, 1), (1, 2), (1, 3), (1, 4),
-- Prof 7 Popović — FON predmeti 5–8
(7, 5), (7, 6), (7, 7), (7, 8),
-- Prof 2 Nikolić — ETF predmeti 9–12
(2, 9), (2, 10), (2, 11), (2, 12),
-- Prof 8 Đukić — ETF predmeti 13–16
(8, 13), (8, 14), (8, 15), (8, 16),
-- Prof 3 Jovanović — PMF predmeti 17–20 + cross-faculty: Algebra na MAT (34)
(3, 17), (3, 18), (3, 19), (3, 20), (3, 34),
-- Prof 9 Lazić — PMF predmeti 21–24
(9, 21), (9, 22), (9, 23), (9, 24),
-- Prof 4 Milošević — EKF predmeti 25–28
(4, 25), (4, 26), (4, 27), (4, 28),
-- Prof 10 Vasić — EKF predmeti 29–32
(10, 29), (10, 30), (10, 31), (10, 32),
-- Prof 5 Đorđević — MAT predmeti 33–40 + cross-faculty: Analiza 1 na PMF (17)
(5, 17), (5, 33), (5, 34), (5, 35), (5, 36), (5, 37), (5, 38), (5, 39), (5, 40),
-- Prof 6 Stojanović — FTN predmeti 41–48
(6, 41), (6, 42), (6, 43), (6, 44), (6, 45), (6, 46), (6, 47), (6, 48);


-- ── exams ───────────────────────────────────────────────────────────────────
-- FON studenti (1–15), predmeti 1–8, profesori 1 i 7
INSERT INTO academic.exams (student_id, subject_id, professor_id, exam_date, grade) VALUES
(1,  1,  1, '2023-06-15', 8),
(1,  2,  1, '2023-09-10', 7),
(2,  1,  1, '2023-06-15', 9),
(2,  3,  1, '2023-09-10', 5),
(3,  2,  1, '2023-06-15', 6),
(3,  5,  7, '2023-09-10', 8),
(4,  1,  1, '2023-06-15', 7),
(4,  4,  1, '2024-01-20', 5),
(5,  3,  1, '2023-06-15', 10),
(5,  6,  7, '2024-01-20', 9),
(6,  2,  1, '2023-09-10', 8),
(6,  5,  7, '2024-01-20', 7),
(7,  1,  1, '2023-09-10', 6),
(7,  7,  7, '2024-01-20', 8),
(8,  3,  1, '2023-09-10', 9),
(8,  6,  7, '2024-01-20', 5),
(9,  2,  1, '2023-09-10', 7),
(9,  4,  1, '2024-01-20', 8),
(10, 1,  1, '2024-01-20', 5),
(10, 8,  7, '2024-01-20', 6),
(11, 3,  1, '2024-01-20', 9),
(11, 5,  7, '2024-06-10', 8),
(12, 4,  1, '2024-01-20', 7),
(12, 7,  7, '2024-06-10', 6),
(13, 2,  1, '2024-06-10', 8),
(13, 6,  7, '2024-06-10', 7),
(14, 1,  1, '2024-06-10', 5),
(14, 8,  7, '2024-06-10', 9),
(15, 3,  1, '2024-06-10', 6),
(15, 7,  7, '2024-06-10', 8);

-- ETF studenti (16–30), predmeti 9–16, profesori 2 i 8
INSERT INTO academic.exams (student_id, subject_id, professor_id, exam_date, grade) VALUES
(16, 9,  2, '2023-06-15', 8),
(16, 11, 2, '2023-09-10', 7),
(17, 9,  2, '2023-06-15', 5),
(17, 13, 8, '2023-09-10', 6),
(18, 10, 2, '2023-06-15', 9),
(18, 12, 2, '2023-09-10', 8),
(19, 9,  2, '2023-06-15', 7),
(19, 14, 8, '2024-01-20', 5),
(20, 11, 2, '2023-09-10', 6),
(20, 15, 8, '2024-01-20', 8),
(21, 10, 2, '2023-09-10', 10),
(21, 13, 8, '2024-01-20', 9),
(22, 9,  2, '2023-09-10', 7),
(22, 16, 8, '2024-01-20', 8),
(23, 12, 2, '2024-01-20', 5),
(23, 14, 8, '2024-01-20', 7),
(24, 10, 2, '2024-01-20', 8),
(24, 15, 8, '2024-06-10', 6),
(25, 11, 2, '2024-01-20', 9),
(25, 13, 8, '2024-06-10', 7),
(26, 9,  2, '2024-01-20', 6),
(26, 16, 8, '2024-06-10', 5),
(27, 12, 2, '2024-01-20', 8),
(27, 14, 8, '2024-06-10', 9),
(28, 10, 2, '2024-06-10', 7),
(28, 15, 8, '2024-06-10', 8),
(29, 11, 2, '2024-06-10', 5),
(29, 13, 8, '2024-06-10', 6),
(30, 9,  2, '2024-06-10', 9),
(30, 16, 8, '2024-06-10', 7);

-- PMF studenti (31–45), predmeti 17–24, profesori 3, 9 i 5 (cross-faculty)
INSERT INTO academic.exams (student_id, subject_id, professor_id, exam_date, grade) VALUES
(31, 17, 3, '2023-06-15', 9),
(31, 18, 3, '2023-09-10', 8),
(32, 17, 3, '2023-06-15', 7),
(32, 20, 3, '2023-09-10', 6),
(33, 18, 3, '2023-06-15', 10),
(33, 21, 9, '2023-09-10', 9),
(34, 19, 3, '2023-06-15', 5),
(34, 22, 9, '2024-01-20', 7),
(35, 17, 5, '2023-06-15', 8),
(35, 23, 9, '2024-01-20', 6),
(36, 20, 3, '2023-09-10', 7),
(36, 24, 9, '2024-01-20', 8),
(37, 18, 3, '2023-09-10', 5),
(37, 21, 9, '2024-01-20', 9),
(38, 17, 3, '2023-09-10', 8),
(38, 22, 9, '2024-01-20', 7),
(39, 19, 3, '2024-01-20', 6),
(39, 23, 9, '2024-06-10', 5),
(40, 17, 5, '2024-01-20', 9),
(40, 24, 9, '2024-06-10', 8),
(41, 20, 3, '2024-06-10', 7),
(41, 21, 9, '2024-06-10', 6),
(42, 18, 3, '2024-06-10', 5),
(42, 22, 9, '2024-06-10', 9),
(43, 19, 3, '2024-06-10', 8),
(43, 23, 9, '2024-06-10', 7),
(44, 17, 3, '2024-06-10', 6),
(44, 24, 9, '2024-06-10', 5),
(45, 20, 3, '2024-06-10', 9),
(45, 18, 3, '2024-06-10', 8);

-- EKF studenti (46–60), predmeti 25–32, profesori 4 i 10
INSERT INTO academic.exams (student_id, subject_id, professor_id, exam_date, grade) VALUES
(46, 25,  4, '2023-06-15', 8),
(46, 27,  4, '2023-09-10', 7),
(47, 25,  4, '2023-06-15', 5),
(47, 29, 10, '2023-09-10', 6),
(48, 26,  4, '2023-06-15', 9),
(48, 30, 10, '2024-01-20', 8),
(49, 25,  4, '2023-06-15', 7),
(49, 28,  4, '2024-01-20', 5),
(50, 27,  4, '2023-09-10', 6),
(50, 31, 10, '2024-01-20', 8),
(51, 26,  4, '2023-09-10', 10),
(51, 32, 10, '2024-01-20', 9),
(52, 25,  4, '2023-09-10', 7),
(52, 29, 10, '2024-01-20', 8),
(53, 28,  4, '2024-01-20', 5),
(53, 30, 10, '2024-06-10', 7),
(54, 26,  4, '2024-01-20', 8),
(54, 31, 10, '2024-06-10', 6),
(55, 27,  4, '2024-01-20', 9),
(55, 29, 10, '2024-06-10', 7),
(56, 25,  4, '2024-01-20', 6),
(56, 32, 10, '2024-06-10', 5),
(57, 28,  4, '2024-06-10', 8),
(57, 30, 10, '2024-06-10', 9),
(58, 26,  4, '2024-06-10', 7),
(58, 31, 10, '2024-06-10', 6),
(59, 27,  4, '2024-06-10', 5),
(59, 29, 10, '2024-06-10', 8),
(60, 25,  4, '2024-06-10', 9),
(60, 32, 10, '2024-06-10', 7);

-- MAT studenti (61–75), predmeti 33–40, profesor 5 (i prof 3 cross-faculty za subj 34)
INSERT INTO academic.exams (student_id, subject_id, professor_id, exam_date, grade) VALUES
(61, 33, 5, '2023-06-15', 9),
(61, 34, 5, '2023-09-10', 8),
(62, 33, 5, '2023-06-15', 7),
(62, 35, 5, '2023-09-10', 5),
(63, 34, 3, '2023-06-15', 8),
(63, 36, 5, '2024-01-20', 6),
(64, 33, 5, '2023-06-15', 10),
(64, 37, 5, '2024-01-20', 9),
(65, 35, 5, '2023-09-10', 7),
(65, 38, 5, '2024-01-20', 8),
(66, 34, 5, '2023-09-10', 5),
(66, 39, 5, '2024-06-10', 6),
(67, 33, 5, '2023-09-10', 9),
(67, 40, 5, '2024-06-10', 8),
(68, 36, 5, '2024-01-20', 7),
(68, 37, 5, '2024-06-10', 5),
(69, 34, 3, '2024-01-20', 8),
(69, 38, 5, '2024-06-10', 9),
(70, 33, 5, '2024-01-20', 6),
(70, 39, 5, '2024-06-10', 7);

-- FTN studenti (76–90), predmeti 41–48, profesor 6
INSERT INTO academic.exams (student_id, subject_id, professor_id, exam_date, grade) VALUES
(76, 41, 6, '2023-06-15', 8),
(76, 43, 6, '2023-09-10', 7),
(77, 41, 6, '2023-06-15', 5),
(77, 44, 6, '2023-09-10', 6),
(78, 42, 6, '2023-06-15', 9),
(78, 45, 6, '2024-01-20', 8),
(79, 41, 6, '2023-06-15', 7),
(79, 46, 6, '2024-01-20', 5),
(80, 43, 6, '2023-09-10', 6),
(80, 47, 6, '2024-01-20', 8),
(81, 42, 6, '2023-09-10', 10),
(81, 48, 6, '2024-01-20', 9),
(82, 41, 6, '2023-09-10', 7),
(82, 44, 6, '2024-01-20', 8),
(83, 43, 6, '2024-01-20', 5),
(83, 45, 6, '2024-06-10', 7),
(84, 42, 6, '2024-01-20', 8),
(84, 46, 6, '2024-06-10', 6),
(85, 44, 6, '2024-01-20', 9),
(85, 47, 6, '2024-06-10', 7);


COMMIT;
