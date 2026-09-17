const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL || "";

async function migrate() {
    if (!DATABASE_URL) {
        console.log("DATABASE_URL не задан — пропускаем миграцию.");
        return;
    }

    const pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        // В старой версии проекта Telegram ID мог быть создан как INTEGER.
        // Сейчас Telegram ID храним как TEXT: это безопаснее и не зависит
        // от типа/длины числового ID Telegram.
        const columns = [
            ["passengers", "telegram_id"],
            ["drivers", "telegram_id"],
            ["passenger_orders", "id"],
            ["passenger_orders", "telegram_user_id"],
            ["passenger_orders", "driver_telegram_id"]
        ];

        for (const [table, column] of columns) {
            const result = await pool.query(
                `
                SELECT data_type
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = $1
                  AND column_name = $2
                `,
                [table, column]
            );

            if (!result.rows.length) {
                continue;
            }

            if (result.rows[0].data_type !== "text") {
                console.log(`Исправляем ${table}.${column}: ${result.rows[0].data_type} -> text`);

                await pool.query(
                    `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE TEXT USING ${column}::text`
                );
            }
        }

        console.log("Проверка типов PostgreSQL завершена.");
    } finally {
        await pool.end();
    }
}

migrate()
    .then(() => {
        require("./server.js");
    })
    .catch((error) => {
        console.error("Ошибка миграции PostgreSQL:", error);
        process.exit(1);
    });
