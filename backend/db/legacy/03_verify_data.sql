-- ============================================================
-- 03_verify_data.sql — Provera podataka
-- ============================================================


-- 1. Svi studenti sa nazivom fakulteta i departmana
SELECT
    s.id,
    s.first_name,
    s.last_name,
    s.index_number,
    s.enrollment_year,
    f.name        AS faculty,
    d.name        AS department
FROM students s
JOIN faculties f ON s.faculty_id = f.id
LEFT JOIN departments d ON s.department_id = d.id
ORDER BY f.name, s.last_name;


-- 2. Svi predmeti sa nazivom fakulteta
SELECT
    sub.id,
    sub.name      AS subject,
    sub.semester,
    sub.ects,
    f.name        AS faculty,
    f.city
FROM subjects sub
JOIN faculties f ON sub.faculty_id = f.id
ORDER BY f.name, sub.semester;


-- 3. Svi profesori sa predmetima koje predaju
SELECT
    p.id,
    p.title,
    p.first_name,
    p.last_name,
    sub.name      AS subject,
    f.name        AS faculty
FROM professors p
JOIN professor_subjects ps ON p.id = ps.professor_id
JOIN subjects sub           ON ps.subject_id = sub.id
JOIN faculties f             ON sub.faculty_id = f.id
ORDER BY p.last_name, f.name, sub.semester;


-- 4. Svi ispiti sa imenom studenta, predmetom, profesorom, datumom, ocenom i passed statusom
SELECT
    e.id,
    s.first_name || ' ' || s.last_name  AS student,
    s.index_number,
    sub.name                             AS subject,
    p.title || ' ' || p.last_name       AS professor,
    f.name                               AS faculty,
    e.exam_date,
    e.grade,
    e.passed
FROM exams e
JOIN students s   ON e.student_id   = s.id
JOIN subjects sub ON e.subject_id   = sub.id
JOIN professors p ON e.professor_id = p.id
JOIN faculties f  ON sub.faculty_id = f.id
ORDER BY e.exam_date, s.last_name;


-- 5. Samo položeni ispiti (passed = true)
SELECT
    s.first_name || ' ' || s.last_name  AS student,
    sub.name                             AS subject,
    e.grade,
    e.exam_date
FROM exams e
JOIN students s   ON e.student_id = s.id
JOIN subjects sub ON e.subject_id = sub.id
WHERE e.passed = TRUE
ORDER BY e.grade DESC, e.exam_date;


-- 6. Prosečna ocena po studentu
SELECT
    s.first_name || ' ' || s.last_name  AS student,
    s.index_number,
    f.name                               AS faculty,
    COUNT(e.id)                          AS total_exams,
    ROUND(AVG(e.grade), 2)              AS avg_grade
FROM students s
JOIN faculties f ON s.faculty_id = f.id
LEFT JOIN exams e ON s.id = e.student_id
GROUP BY s.id, s.first_name, s.last_name, s.index_number, f.name
ORDER BY avg_grade DESC NULLS LAST;


-- 7. Broj položenih ispita po studentu
SELECT
    s.first_name || ' ' || s.last_name  AS student,
    s.index_number,
    COUNT(*) FILTER (WHERE e.passed = TRUE)  AS passed_count,
    COUNT(*) FILTER (WHERE e.passed = FALSE) AS failed_count,
    COUNT(*)                                  AS total_exams
FROM students s
LEFT JOIN exams e ON s.id = e.student_id
GROUP BY s.id, s.first_name, s.last_name, s.index_number
ORDER BY passed_count DESC;


-- 8. Broj položenih ispita po fakultetu
SELECT
    f.name                                    AS faculty,
    COUNT(*) FILTER (WHERE e.passed = TRUE)  AS passed,
    COUNT(*) FILTER (WHERE e.passed = FALSE) AS failed,
    COUNT(*)                                  AS total
FROM faculties f
LEFT JOIN students s ON f.id = s.faculty_id
LEFT JOIN exams e    ON s.id = e.student_id
GROUP BY f.id, f.name
ORDER BY passed DESC;


-- 9. Prosečna ocena po fakultetu
SELECT
    f.name                     AS faculty,
    ROUND(AVG(e.grade), 2)    AS avg_grade,
    COUNT(e.id)                AS total_exams
FROM faculties f
LEFT JOIN students s ON f.id = s.faculty_id
LEFT JOIN exams e    ON s.id = e.student_id
GROUP BY f.id, f.name
ORDER BY avg_grade DESC NULLS LAST;


-- 10. Predmeti koje je polagalo najviše studenata
SELECT
    sub.name                    AS subject,
    f.name                      AS faculty,
    COUNT(DISTINCT e.student_id) AS num_students,
    ROUND(AVG(e.grade), 2)      AS avg_grade
FROM subjects sub
JOIN faculties f ON sub.faculty_id = f.id
LEFT JOIN exams e ON sub.id = e.subject_id
GROUP BY sub.id, sub.name, f.name
ORDER BY num_students DESC, avg_grade DESC;
