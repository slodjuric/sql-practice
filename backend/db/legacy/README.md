# Legacy development scripts

These scripts are **not needed for normal setup**.

They were used during the initial development of the database schema and contain
incremental migrations that were applied manually over time:

| File | What it did |
|---|---|
| `01_create_tables.sql` | Original table creation (broken — references departments before it exists) |
| `02_insert_data.sql` | Inserted practice data |
| `03_verify_data.sql` | SELECT-only verification queries |
| `04_alter_schema.sql` | Added department FK columns; dropped legacy `employees` table |
| `05_populate_departments.sql` | Inserted 17 university departments; set FK references |
| `06_fix_departments.sql` | Added `location` column; added NOT NULL constraints |

## Use this instead

```bash
cd backend
npm run db:init
```

This runs `backend/db/init-practice-db.sql`, which is a single clean file that
creates and populates all 7 practice tables from scratch in the correct final schema.
