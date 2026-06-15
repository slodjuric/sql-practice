-- Drop in reverse dependency order
DROP TABLE IF EXISTS exams CASCADE;
DROP TABLE IF EXISTS professor_subjects CASCADE;
DROP TABLE IF EXISTS students CASCADE;
DROP TABLE IF EXISTS professors CASCADE;
DROP TABLE IF EXISTS subjects CASCADE;
DROP TABLE IF EXISTS faculties CASCADE;

-- --------------------------------------------------------

CREATE TABLE faculties (
    id               SERIAL PRIMARY KEY,
    name             VARCHAR(150) NOT NULL,
    city             VARCHAR(100) NOT NULL,
    university_name  VARCHAR(150) NOT NULL,
    department_id    INTEGER REFERENCES departments(id)
);

-- --------------------------------------------------------

CREATE TABLE subjects (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(150) NOT NULL,
    semester    SMALLINT     NOT NULL CHECK (semester BETWEEN 1 AND 12),
    ects        SMALLINT     NOT NULL CHECK (ects BETWEEN 1 AND 30),
    faculty_id  INTEGER      NOT NULL REFERENCES faculties(id)
);

-- --------------------------------------------------------

CREATE TABLE professors (
    id          SERIAL PRIMARY KEY,
    first_name  VARCHAR(100) NOT NULL,
    last_name   VARCHAR(100) NOT NULL,
    title       VARCHAR(50),
    email       VARCHAR(150) UNIQUE NOT NULL
);

-- --------------------------------------------------------

CREATE TABLE professor_subjects (
    id            SERIAL PRIMARY KEY,
    professor_id  INTEGER NOT NULL REFERENCES professors(id),
    subject_id    INTEGER NOT NULL REFERENCES subjects(id),
    UNIQUE (professor_id, subject_id)
);

-- --------------------------------------------------------

CREATE TABLE students (
    id               SERIAL PRIMARY KEY,
    first_name       VARCHAR(100) NOT NULL,
    last_name        VARCHAR(100) NOT NULL,
    index_number     VARCHAR(20)  UNIQUE NOT NULL,
    enrollment_year  SMALLINT     NOT NULL,
    faculty_id       INTEGER      NOT NULL REFERENCES faculties(id),
    department_id    INTEGER      REFERENCES departments(id)
);

-- --------------------------------------------------------

CREATE TABLE exams (
    id            SERIAL PRIMARY KEY,
    student_id    INTEGER  NOT NULL REFERENCES students(id),
    subject_id    INTEGER  NOT NULL REFERENCES subjects(id),
    professor_id  INTEGER  NOT NULL REFERENCES professors(id),
    exam_date     DATE     NOT NULL,
    grade         SMALLINT NOT NULL CHECK (grade BETWEEN 5 AND 10),
    passed        BOOLEAN  NOT NULL GENERATED ALWAYS AS (grade > 5) STORED
);
